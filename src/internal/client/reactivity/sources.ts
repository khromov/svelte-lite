import type { Derived, Effect, Source, Value } from '../types.ts';
import { DEV } from 'esm-env';
import {
	active_reaction,
	active_effect,
	untracked_writes,
	get,
	set_untracked_writes,
	update_effect,
	current_sources,
	is_dirty,
	untracking,
	push_reaction_value,
	is_destroying_effect
} from '../runtime.ts';
import { equals, safe_equals } from './equality.ts';
import {
	CLEAN,
	DERIVED,
	DIRTY,
	BRANCH_EFFECT,
	EAGER_EFFECT,
	MAYBE_DIRTY,
	BLOCK_EFFECT,
	ROOT_EFFECT,
	ASYNC,
	ASSIGNED,
	ERROR_VALUE
} from '../constants.ts';
import * as e from '../errors.ts';
import { tracing_mode_flag } from '../../flags/index.ts';
import { tag_proxy } from '../dev/tracing.ts';
import { get_error } from '../../shared/dev.ts';
import {
	Batch,
	batch_values,
	legacy_updates,
	in_real_world,
	teardown_write,
	source_stacks
} from './batch.ts';
import { proxy } from '../proxy.ts';
import { execute_derived } from './deriveds.ts';
import { set_signal_status } from './status.ts';
import { unsupported } from '../../../unsupported.ts';

export let eager_effects: Set<Effect> = new Set();

export function set_eager_effects(v: Set<any>): void {
	eager_effects = v;
}

export let eager_effects_deferred = false;

export function set_eager_effects_deferred(): void {
	eager_effects_deferred = true;
}

// TODO rename this to `state` throughout the codebase
export function source<V>(v: V, stack?: Error | null): Source<V> {
	var signal: Source<V> = {
		f: 0,
		v,
		reactions: null,
		equals,
		rv: 0,
		wv: 0
	};

	if (DEV && tracing_mode_flag) {
		signal.created = stack ?? get_error('created at');
		signal.updated = null;
		signal.set_during_effect = false;
		signal.trace = null;
	}

	return signal;
}

/*#__NO_SIDE_EFFECTS__*/
export function state<V>(v: V, stack?: Error | null): Source<V> {
	const s = source(v, stack);

	push_reaction_value(s);

	return s;
}

/**
 * A source that also notifies when it is set to the object or function it already holds, which
 * may have been mutated. Legacy mode is left out of svelte-lite, and with it the tracking of such
 * sources for `beforeUpdate`/`afterUpdate`, which is what `trackable` was for. What is left is what
 * `createClassComponent` (`svelte/legacy`) needs for the props of the component it wraps
 */
/*#__NO_SIDE_EFFECTS__*/
export function mutable_source<V>(
	initial_value: V,
	immutable: boolean = false,
	trackable: boolean = true
): Source<V> {
	const s = source(initial_value);
	if (!immutable) {
		s.equals = safe_equals;
	}

	return s;
}

/**
 * Only a legacy mode component is compiled to a call of this, for a mutation of state that is
 * not a proxy, so nothing is behind it. The name stays for as long as `internal/client/index`
 * re-exports it
 */
export function mutate<V>(source: Value<V>, value: V): V {
	unsupported('legacy mode: components have to use runes');
}

export function set<V>(source: Value<V>, value: V, should_proxy: boolean = false): V {
	if (
		active_reaction !== null &&
		// since we are untracking the function inside `$inspect.with` we need to add this check
		// to ensure we error if state is set inside an inspect effect
		(!untracking || (active_reaction.f & EAGER_EFFECT) !== 0) &&
		(active_reaction.f & (DERIVED | BLOCK_EFFECT | ASYNC | EAGER_EFFECT)) !== 0 &&
		(current_sources === null || !current_sources.has(source))
	) {
		e.state_unsafe_mutation();
	}

	let new_value = should_proxy ? proxy(value) : value;

	if (DEV) {
		tag_proxy(new_value, source.label as string);
	}

	return internal_set(source, new_value, legacy_updates);
}

export function internal_set<V>(
	source: Value<V>,
	value: V,
	updated_during_traversal: Effect[] | null = null
): V {
	var same = source.equals(value) && (source.f & ERROR_VALUE) === 0;
	var entry = batch_values?.get(source);

	// A value that equals the real one may still overwrite a different value in the active view.
	if (!same || (entry !== undefined && (entry.e || !source.equals.call(entry, value)))) {
		var batch = Batch.ensure();

		// If we are assigning to a dirty derived we eagerly execute it to track the dependencies. (Not if
		// it's assigned already: it tracks them, and its flags don't tell whether the assignment still holds,
		// which is what other views see when they undo this one — see `is_dirty`)
		if ((source.f & (DERIVED | DIRTY | ASSIGNED)) === (DERIVED | DIRTY)) {
			execute_derived(source as Derived<V>);
		}

		batch.capture(source, value, same, false, updated_during_traversal);

		if (DEV) {
			if (tracing_mode_flag || active_effect !== null) {
				source.updated ??= new Map();
				source_stacks.add(source);

				// For performance reasons, when not using $inspect.trace, we only start collecting stack traces
				// after the same source has been updated more than 5 times in the same flush cycle.
				const count = (source.updated.get('')?.count ?? 0) + 1;
				source.updated.set('', { error: null as any, count });

				if (tracing_mode_flag || count > 5) {
					const error = get_error('updated at');

					if (error !== null) {
						let entry = source.updated.get(error.stack);

						if (!entry) {
							entry = { error, count: 0 };
							source.updated.set(error.stack, entry);
						}

						entry.count++;
					}
				}
			}

			if (active_effect !== null) {
				source.set_during_effect = true;
			}
		}

		// It's possible that the current reaction might not have up-to-date dependencies
		// whilst it's actively running. So in the case of ensuring it registers the reaction
		// properly for itself, we need to ensure the current effect actually gets
		// scheduled. i.e: `$effect(() => x++)`
		if (
			active_effect !== null &&
			(active_effect.f & CLEAN) !== 0 &&
			(active_effect.f & (BRANCH_EFFECT | ROOT_EFFECT)) === 0
		) {
			if (untracked_writes === null) {
				set_untracked_writes([source]);
			} else {
				untracked_writes.push(source);
			}
		}
	} else if (is_destroying_effect) {
		// not a change, but the teardown no longer sees a reverted value
		teardown_write(source);
	}

	return value;
}

export function flush_eager_effects(): void {
	eager_effects_deferred = false;

	// eager effects run in the real world, not in the view of a batch
	in_real_world(run_eager_effects);
}

function run_eager_effects(): void {
	for (const effect of eager_effects) {
		// Mark clean inspect-effects as maybe dirty and then check their dirtiness
		// instead of just updating the effects - this way we avoid overfiring.
		if ((effect.f & CLEAN) !== 0) {
			set_signal_status(effect, MAYBE_DIRTY);
		}

		let dirty;

		try {
			dirty = is_dirty(effect);
		} catch {
			// Dirty-checking can evaluate derived dependencies and throw in cases where
			// parent effects are about to destroy this eager effect. Run the effect so
			// its own error handling can deal with transient failures.
			dirty = true;
		}

		if (dirty) {
			update_effect(effect);
		}
	}

	eager_effects.clear();
}

export function update<T extends number | bigint>(source: Source<T>, d: 1 | -1 = 1): T {
	// (`++` and `--` work on a bigint as they do on a number, which the types can't express)
	var value: any = get(source);
	var result = d === 1 ? value++ : value--;

	set(source, value);

	return result as T;
}

export function update_pre<T extends number | bigint>(source: Source<T>, d: 1 | -1 = 1): T {
	var value: any = get(source);

	return set(source, (d === 1 ? ++value : --value) as T);
}

/**
 * Silently (without using `get`) increment a source
 */
export function increment(source: Source<number>): void {
	set(source, source.v + 1);
}
