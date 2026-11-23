import type {
	Component,
	ComponentConstructorOptions,
	ComponentType,
	SvelteComponent
} from '../index.ts';
import type { Effect, Source } from '../internal/client/types.ts';
// in the order of Svelte's module: the runtime's modules import each other in cycles,
// and an entry point decides in which order they run
import { DIRTY, LEGACY_PROPS, MAYBE_DIRTY } from '../internal/client/constants.ts';
import { user_pre_effect } from '../internal/client/reactivity/effects.ts';
import { set, source } from '../internal/client/reactivity/sources.ts';
import { safe_equals } from '../internal/client/reactivity/equality.ts';
import { hydrate, mount, unmount } from '../internal/client/render.ts';
import { active_effect, get } from '../internal/client/runtime.ts';
import { flushSync } from '../internal/client/reactivity/batch.ts';
import { define_property, is_array } from '../internal/shared/utils.ts';
import * as e from '../internal/client/errors.ts';
import * as w from '../internal/client/warnings.ts';
import { DEV } from 'esm-env';
import { FILENAME } from '../constants.ts';
import { component_context, dev_current_component_function } from '../internal/client/context.ts';
import { set_signal_status } from '../internal/client/reactivity/status.ts';

// `svelte/legacy` is not legacy mode: it is what a runes component uses to keep working with
// code that was written for Svelte 4. Custom elements are built on `createClassComponent` too.

/**
 * Takes the same options as a Svelte 4 component and the component function and returns a Svelte 4 compatible component.
 *
 * @deprecated Use this only as a temporary solution to migrate your imperative component code to Svelte 5.
 */
export function createClassComponent<
	Props extends Record<string, any>,
	Exports extends Record<string, any>,
	Events extends Record<string, any>,
	Slots extends Record<string, any>
>(
	options: ComponentConstructorOptions<Props> & {
		component: ComponentType<SvelteComponent<Props, Events, Slots>> | Component<Props>;
	}
): SvelteComponent<Props, Events, Slots> & Exports {
	// `$$prop_def` etc are not actually defined
	return new Svelte4Component(options) as any;
}

/**
 * Takes the component function and returns a Svelte 4 compatible component constructor.
 *
 * @deprecated Use this only as a temporary solution to migrate your imperative component code to Svelte 5.
 */
export function asClassComponent<
	Props extends Record<string, any>,
	Exports extends Record<string, any>,
	Events extends Record<string, any>,
	Slots extends Record<string, any>
>(
	component: SvelteComponent<Props, Events, Slots> | Component<Props>
): ComponentType<SvelteComponent<Props, Events, Slots> & Exports> {
	// `$$prop_def` etc are not actually defined
	return class extends Svelte4Component {
		constructor(options: any) {
			super({
				component,
				...options
			});
		}
	} as any;
}

class Svelte4Component {
	#events: any;

	#instance: Record<string, any>;

	constructor(options: ComponentConstructorOptions & { component: any }) {
		var sources = new Map<string | symbol, Source<any>>();

		var add_source = (key: string | symbol, value: unknown) => {
			// as in Svelte 4, setting a prop to the object it already holds notifies,
			// because the object may have been mutated
			var s = source(value);
			s.equals = safe_equals;
			sources.set(key, s);
			return s;
		};

		// Replicate coarse-grained props through a proxy that has a version source for
		// each property, which is incremented on updates to the property itself. Do not
		// use our $state proxy because that one has fine-grained reactivity.
		const props = new Proxy<Record<string | symbol, any>>(
			{ ...(options.props || {}), $$events: {} },
			{
				get(target, prop) {
					return get(sources.get(prop) ?? add_source(prop, Reflect.get(target, prop)));
				},
				has(target, prop) {
					// Necessary to not throw "invalid binding" validation errors on the component side
					if (prop === LEGACY_PROPS) return true;

					get(sources.get(prop) ?? add_source(prop, Reflect.get(target, prop)));
					return Reflect.has(target, prop);
				},
				set(target, prop, value) {
					set(sources.get(prop) ?? add_source(prop, value), value);
					return Reflect.set(target, prop, value);
				}
			}
		);

		const render_options = {
			target: options.target,
			anchor: options.anchor,
			props,
			context: options.context,
			intro: options.intro ?? false,
			recover: options.recover,
			transformError: options.transformError
		};

		this.#instance = options.hydrate
			? hydrate(options.component, render_options)
			: mount(options.component, render_options);

		// We don't flushSync for custom element wrappers or if the user doesn't want it
		if (!options?.props?.$$host || options.sync === false) {
			flushSync();
		}

		this.#events = props.$$events;

		for (const key of Object.keys(this.#instance)) {
			if (key === '$set' || key === '$destroy' || key === '$on') continue;
			define_property(this, key, {
				get(this: Svelte4Component) {
					return this.#instance[key];
				},
				set(this: Svelte4Component, value: any) {
					this.#instance[key] = value;
				},
				enumerable: true
			});
		}

		this.#instance.$set = (next: Record<string, any>) => {
			Object.assign(props, next);
		};

		this.#instance.$destroy = () => {
			unmount(this.#instance);
		};
	}

	$set(props: Record<string, any>): void {
		this.#instance.$set(props);
	}

	$on(event: string, callback: (...args: any[]) => any): any {
		this.#events[event] = this.#events[event] || [];

		const cb = (...args: any[]) => callback.call(this, ...args);
		this.#events[event].push(cb);
		return () => {
			this.#events[event] = this.#events[event].filter((fn: any) => fn !== cb);
		};
	}

	$destroy(): void {
		this.#instance.$destroy();
	}
}

/**
 * Runs the given function once immediately on the server, and works like `$effect.pre` on the client.
 *
 * @deprecated Use this only as a temporary solution to migrate your component code to Svelte 5.
 */
export function run(fn: () => void | (() => void)): void {
	user_pre_effect(() => {
		fn();
		var effect = active_effect as Effect;
		// If the effect is immediately made dirty again, mark it as maybe dirty to emulate legacy behaviour
		if ((effect.f & DIRTY) !== 0) {
			let filename = "a file (we can't know which one)";
			if (DEV) {
				filename = (dev_current_component_function as any)?.[FILENAME] ?? filename;
			}
			w.legacy_recursive_reactive_block(filename);
			set_signal_status(effect, MAYBE_DIRTY);
		}
	});
}

/**
 * Function to mimic the multiple listeners available in svelte 4
 * @deprecated
 */
export function handlers(...handlers: EventListener[]): EventListener {
	return function (this: unknown, event) {
		const { stopImmediatePropagation } = event;
		let stopped = false;

		event.stopImmediatePropagation = () => {
			stopped = true;
			stopImmediatePropagation.call(event);
		};

		const errors: unknown[] = [];

		for (const handler of handlers) {
			try {
				handler?.call(this, event);
			} catch (e) {
				errors.push(e);
			}

			if (stopped) {
				break;
			}
		}

		for (let error of errors) {
			queueMicrotask(() => {
				throw error;
			});
		}
	};
}

/**
 * Function to create a `bubble` function that mimic the behavior of `on:click` without handler available in svelte 4.
 * @deprecated Use this only as a temporary solution to migrate your automatically delegated events in Svelte 5.
 */
export function createBubbler(): (type: string) => (event: Event) => boolean {
	const active_component_context = component_context;
	if (active_component_context === null) {
		e.lifecycle_outside_component('createBubbler');
	}

	return (type) => (event) => {
		const events = (
			active_component_context.s.$$events as Record<string, Function | Function[]> | undefined
		)?.[type];

		if (events) {
			const callbacks = is_array(events) ? events.slice() : [events];
			for (const fn of callbacks) {
				fn.call(active_component_context.x, event);
			}
			return !event.defaultPrevented;
		}
		return true;
	};
}

export {
	once,
	preventDefault,
	self,
	stopImmediatePropagation,
	stopPropagation,
	trusted,
	passive,
	nonpassive
} from '../internal/client/dom/legacy/event-modifiers.ts';
