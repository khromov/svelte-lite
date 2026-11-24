import type { Derived, Effect } from '../types.ts';
import { DEV } from 'esm-env';
import { PROPS_IS_BINDABLE, PROPS_IS_LAZY_INITIAL, PROPS_IS_UPDATED } from '../../../constants.ts';
import { get_descriptor, is_function } from '../../shared/utils.ts';
import { set } from './sources.ts';
import { derived } from './deriveds.ts';
import { active_effect, get, is_destroying_effect } from '../runtime.ts';
import * as e from '../errors.ts';
import { DESTROYED, LEGACY_PROPS, STATE_SYMBOL } from '../constants.ts';
import { proxy } from '../proxy.ts';
import { capture_store_binding, has_stores } from './store.ts';
import { unsupported } from '../../../unsupported.ts';

export function update_prop(fn: (value?: number) => number, d: 1 | -1 = 1): number {
	const value = fn();
	fn(value + d);
	return value;
}

export function update_pre_prop(fn: (value?: number) => number, d: 1 | -1 = 1): number {
	const value = fn() + d;
	fn(value);
	return value;
}

type Props = Record<string | symbol, unknown>;

/**
 * The proxy handler for rest props (i.e. `const { x, ...rest } = $props()`).
 * Is passed the full `$$props` object and excludes the named props.
 */
const rest_props_handler: ProxyHandler<{
	props: Props;
	exclude: Set<string | symbol>;
	name?: string;
}> = {
	get(target, key) {
		if (target.exclude.has(key)) return;
		return target.props[key];
	},
	set(target, key) {
		if (DEV) {
			// TODO should this happen in prod too?
			e.props_rest_readonly(`${target.name}.${String(key)}`);
		}

		return false;
	},
	getOwnPropertyDescriptor(target, key) {
		if (target.exclude.has(key)) return;
		if (key in target.props) {
			return {
				enumerable: true,
				configurable: true,
				value: target.props[key]
			};
		}
	},
	has(target, key) {
		if (target.exclude.has(key)) return false;
		return key in target.props;
	},
	ownKeys(target) {
		return Reflect.ownKeys(target.props).filter((key) => !target.exclude.has(key));
	}
};

/*#__NO_SIDE_EFFECTS__*/
export function rest_props(
	props: Record<string, unknown>,
	exclude: Set<string>,
	name?: string
): Record<string, unknown> {
	return new Proxy(
		DEV ? { props, exclude, name } : { props, exclude },
		rest_props_handler
	) as unknown as Record<string, unknown>;
}

/**
 * Only a legacy mode component is compiled to a call of this, for `$$props` and `$$restProps`,
 * so nothing is behind it. The name stays for as long as `internal/client/index` re-exports it.
 */
export function legacy_rest_props(): never {
	unsupported('legacy mode: components have to use runes');
}

/**
 * The proxy handler for spread props. Handles the incoming array of props
 * that looks like `() => { dynamic: props }, { static: prop }, ..` and wraps
 * them so that the whole thing is passed to the component as the `$$props` argument.
 */
const spread_props_handler: ProxyHandler<{ props: Array<Props | (() => Props)> }> = {
	get(target, key) {
		let i = target.props.length;
		while (i--) {
			let p = target.props[i];
			if (is_function(p)) p = p();
			if (typeof p === 'object' && p !== null && key in p) return p[key];
		}
	},
	set(target, key, value) {
		let i = target.props.length;
		while (i--) {
			let p = target.props[i];
			if (is_function(p)) p = p();
			const desc = get_descriptor(p, key);
			if (desc && desc.set) {
				desc.set(value);
				return true;
			}
		}
		return false;
	},
	getOwnPropertyDescriptor(target, key) {
		let i = target.props.length;
		while (i--) {
			let p = target.props[i];
			if (is_function(p)) p = p();
			if (typeof p === 'object' && p !== null && key in p) {
				const descriptor = get_descriptor(p, key);
				if (descriptor && !descriptor.configurable) {
					// Prevent a "Non-configurability Report Error": The target is an array, it does
					// not actually contain this property. If it is now described as non-configurable,
					// the proxy throws a validation error. Setting it to true avoids that.
					descriptor.configurable = true;
				}
				return descriptor;
			}
		}
	},
	has(target, key) {
		// To prevent a false positive `is_entry_props` in the `prop` function
		if (key === STATE_SYMBOL || key === LEGACY_PROPS) return false;

		for (let p of target.props) {
			if (is_function(p)) p = p();
			if (p != null && key in p) return true;
		}

		return false;
	},
	ownKeys(target) {
		const keys: Array<string | symbol> = [];

		for (let p of target.props) {
			if (is_function(p)) p = p();
			if (!p) continue;

			for (const key in p) {
				if (!keys.includes(key)) keys.push(key);
			}

			for (const key of Object.getOwnPropertySymbols(p)) {
				if (!keys.includes(key)) keys.push(key);
			}
		}

		return keys;
	}
};

export function spread_props(
	...props: Array<Record<string, unknown> | (() => Record<string, unknown>)>
): any {
	return new Proxy({ props }, spread_props_handler);
}

/**
 * This function is responsible for synchronizing a possibly bound prop with the inner component state.
 * It is used whenever the compiler sees that the component writes to the prop, or when it has a default prop_value.
 *
 * Of the flags the compiler passes, `PROPS_IS_RUNES` and `PROPS_IS_IMMUTABLE` are not read:
 * every component is a runes component, which always has both.
 */
export function prop<V>(
	props: Record<string, unknown>,
	key: string,
	flags: number,
	fallback?: V | (() => V)
): () => V | ((arg: V) => V) | ((arg: V, mutation: boolean) => V) {
	var bindable = (flags & PROPS_IS_BINDABLE) !== 0;
	var lazy = (flags & PROPS_IS_LAZY_INITIAL) !== 0;

	var fallback_value = fallback as V;
	var fallback_dirty = true;
	var fallback_signal: Derived<V> | undefined = undefined;

	var get_fallback = (): V => {
		if (lazy) {
			fallback_signal ??= derived(fallback as () => V);
			return get(fallback_signal);
		}

		if (fallback_dirty) {
			fallback_dirty = false;
			fallback_value = fallback as V;
		}

		return fallback_value;
	};

	let setter: ((v: V) => void) | undefined;

	if (bindable) {
		// Can be the case when someone does `mount(Component, props)` with `let props = $state({...})`,
		// and for the component of a custom element. The latter is not legacy mode despite the
		// name of the symbol (see `element_props` in custom-element.ts)
		var is_entry_props = STATE_SYMBOL in props || LEGACY_PROPS in props;

		setter =
			get_descriptor(props, key)?.set ??
			(is_entry_props && key in props ? (v) => (props[key] = v) : undefined);
	}

	var initial_value: V;
	var is_store_sub = false;

	// (a prop can only be bound to a store by a component that subscribes to one)
	if (bindable && has_stores) {
		[initial_value, is_store_sub] = capture_store_binding(() => props[key] as V);
	} else {
		initial_value = props[key] as V;
	}

	if (initial_value === undefined && fallback !== undefined) {
		// the value is not needed here, but this is where the fallback is first evaluated
		get_fallback();

		if (setter) e.props_invalid_value(key);
	}

	var getter = (): V => {
		var value = props[key] as V;
		if (value === undefined) return get_fallback();
		fallback_dirty = true;
		return value;
	};

	// prop is never written to — we only need a getter
	if ((flags & PROPS_IS_UPDATED) === 0) {
		return getter;
	}

	// prop is written to, but the parent component had `bind:foo` which
	// means we can just call `$$props.foo = value` directly
	if (setter) {
		return function (value: V, mutation: boolean) {
			if (arguments.length > 0) {
				// We don't want to notify if the value was mutated: the state proxy (if it exists)
				// takes care of the notification. A store has to be told, though.
				if (!mutation || is_store_sub) {
					(setter as Function)(mutation ? getter() : value);
				}

				return value;
			}

			return getter();
		} as () => V;
	}

	// prop is written to, but there's no binding, which means we
	// create a derived that we can write to locally
	var overridden = false;

	var d = derived(() => {
		overridden = false;
		return getter();
	});

	if (DEV) {
		d.label = key;
	}

	// Capture the initial value if it's bindable
	if (bindable) get(d);

	var parent_effect = active_effect as Effect;

	return function (value: any, mutation: boolean) {
		if (arguments.length > 0) {
			const new_value = mutation ? get(d) : bindable ? proxy(value) : value;

			set(d, new_value);
			overridden = true;

			if (fallback_value !== undefined) {
				fallback_value = new_value;
			}

			return value;
		}

		// special case — avoid recalculating the derived if we're in a
		// teardown function and the prop was overridden locally, or the
		// component was already destroyed (people could access props in a timeout)
		if ((is_destroying_effect && overridden) || (parent_effect.f & DESTROYED) !== 0) {
			return d.v;
		}

		return get(d);
	} as () => V;
}
