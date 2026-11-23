import type { Derived, Effect, Source, Value } from '../types.ts';
import { DEV } from 'esm-env';
import {
	active_reaction,
	active_effect,
	get,
	update_effect,
	current_sources,
	is_dirty,
	untracking,
	push_reaction_value,
	increment_write_version,
	write_version,
	is_destroying_effect,
	old_values
} from '../runtime.ts';
import { equals } from './equality.ts';
import {
	CLEAN,
	DERIVED,
	DIRTY,
	EAGER_EFFECT,
	MAYBE_DIRTY,
	BLOCK_EFFECT,
	ERROR_VALUE
} from '../constants.ts';
import * as e from '../errors.ts';
import { tracing_mode_flag } from '../../flags/index.ts';
import { tag_proxy } from '../dev/tracing.ts';
import { get_error } from '../../shared/dev.ts';
import { eager_block_effects, schedule_effect, schedule_flush, source_stacks } from './batch.ts';
import { proxy } from '../proxy.ts';
import { execute_derived, has_deriveds } from './deriveds.ts';
import { set_signal_status, update_derived_status } from './status.ts';

/**
 * The effects of `$inspect`, which run as soon as what they read is written rather than with the
 * next flush, so that the stack trace they log leads to the write. Only ever filled in dev mode
 */
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
 * @param should_proxy whether `value` is to be made deeply reactive. This has no default value on
 * purpose: where every call leaves the argument out, a bundler can tell that `proxy` is not needed
 * and drops it, which a default value keeps it from seeing
 */
export function set<V>(source: Value<V>, value: V, should_proxy?: boolean): V {
	if (
		DEV &&
		active_reaction !== null &&
		// since we are untracking the function inside `$inspect.with` we need to add this check
		// to ensure we error if state is set inside an inspect effect
		(!untracking || (active_reaction.f & EAGER_EFFECT) !== 0) &&
		(active_reaction.f & (DERIVED | BLOCK_EFFECT | EAGER_EFFECT)) !== 0 &&
		(current_sources === null || !current_sources.has(source))
	) {
		e.state_unsafe_mutation();
	}

	let new_value = should_proxy ? proxy(value) : value;

	if (DEV) {
		tag_proxy(new_value, source.label as string);
	}

	return internal_set(source, new_value);
}

export function internal_set<V>(source: Value<V>, value: V): V {
	// (a derived whose value is an error can be assigned that same value)
	if (!source.equals(value) || (has_deriveds && (source.f & ERROR_VALUE) !== 0)) {
		if (has_deriveds && (source.f & DERIVED) !== 0) {
			// If we are assigning to a dirty derived, we execute it first to track its dependencies:
			// the value that is assigned holds until one of them changes
			if ((source.f & DIRTY) !== 0) {
				execute_derived(source as Derived<V>);
			}

			source.f &= ~ERROR_VALUE;
			update_derived_status(source as Derived<V>);
		}

		var previous = source.v;
		source.v = value;
		source.wv = increment_write_version();

		// what a teardown sees (see `old_values`): the value from before the change, or what a
		// teardown wrote
		if (is_destroying_effect) {
			old_values.set(source, { v: value, wv: Infinity });
		} else if (!old_values.has(source)) {
			old_values.set(source, { v: previous, wv: source.wv });
			schedule_flush();
		}

		if (DEV) {
			if (tracing_mode_flag || active_effect !== null) {
				source.updated ??= new Map();
				source_stacks.add(source);

				// (the flush resets what is recorded here, also if the write schedules nothing)
				schedule_flush();

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

		mark_reactions(source, DIRTY);

		if (DEV && eager_effects.size > 0 && !eager_effects_deferred) {
			flush_eager_effects();
		}
	}

	return value;
}

/**
 * Runs the effects of `$inspect` that a write reached. Only called in dev mode
 */
export function flush_eager_effects(): void {
	eager_effects_deferred = false;

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

/**
 * Tell everything that depends on `signal` that it may have to run again: what read it directly
 * is DIRTY, what read it through a derived is MAYBE_DIRTY and compares versions first (see `is_dirty`)
 * @param status should be DIRTY or MAYBE_DIRTY
 */
function mark_reactions(signal: Value, status: number): void {
	var reactions = signal.reactions;
	if (reactions === null) return;

	for (var i = 0; i < reactions.length; i++) {
		var reaction = reactions[i];
		var flags = reaction.f;
		var not_dirty = (flags & DIRTY) === 0;

		// don't set a DIRTY reaction to MAYBE_DIRTY
		if (not_dirty) {
			set_signal_status(reaction, status);
		}

		if (has_deriveds && (flags & DERIVED) !== 0) {
			var derived = reaction as Derived;

			// A derived that depends on `signal` in more than one way is only passed once per write
			// (which is what the version stands for): each of the ways to it leads to the same
			// reactions, and the number of ways can grow exponentially with the number of deriveds
			if (derived.mv !== write_version) {
				derived.mv = write_version;
				mark_reactions(derived, MAYBE_DIRTY);
			}
		} else if (DEV && (flags & EAGER_EFFECT) !== 0) {
			// The effects of `$inspect` run immediately, so that the stack trace makes sense
			eager_effects.add(reaction as Effect);
		} else if (not_dirty) {
			if ((flags & BLOCK_EFFECT) !== 0 && eager_block_effects !== null) {
				// an effect is writing: the block runs as soon as it is done (see `flush_effects`)
				eager_block_effects.push(reaction as Effect);
			}

			schedule_effect(reaction as Effect);
		}
	}
}
