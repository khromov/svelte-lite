import type { Derived, Effect, Reaction, Value } from './types.ts';
import { DEV } from 'esm-env';
import { get_descriptors, get_prototype_of, includes, index_of } from '../shared/utils.ts';
import {
	destroy_block_effect_children,
	destroy_effect_children,
	execute_effect_teardown
} from './reactivity/effects.ts';
import {
	DIRTY,
	MAYBE_DIRTY,
	CLEAN,
	DERIVED,
	DESTROYED,
	BRANCH_EFFECT,
	STATE_SYMBOL,
	BLOCK_EFFECT,
	ROOT_EFFECT,
	CONNECTED,
	REACTION_IS_UPDATING,
	ERROR_VALUE,
	MANAGED_EFFECT,
	REACTION_RAN,
	STALE_REACTION
} from './constants.ts';
import {
	freeze_derived_effects,
	has_deriveds,
	unfreeze_derived_effects,
	update_derived
} from './reactivity/deriveds.ts';
import { async_mode_flag, tracing_mode_flag } from '../flags/index.ts';
import { tracing_expressions } from './dev/tracing.ts';
import { get_error } from '../shared/dev.ts';
import {
	component_context,
	dev_current_component_function,
	dev_stack,
	set_component_context,
	set_dev_current_component_function,
	set_dev_stack
} from './context.ts';
import { flushSync } from './reactivity/batch.ts';
import { handle_error } from './error-handling.ts';
import { UNINITIALIZED } from '../../constants.ts';
import { set_signal_status, update_derived_status } from './reactivity/status.ts';
import { without_reactive_context } from './dom/elements/bindings/shared.ts';

// The signal graph: sources, deriveds and effects, and how a reaction (a derived or an effect)
// finds out what it depends on and whether it has to run again. When the effects run is decided
// in `reactivity/batch.ts`.
//
// A signal has a write version (`wv`). A reaction is out of date when one of its dependencies
// has a later version than the reaction itself, which is only checked for a reaction that was
// marked: DIRTY when a source it read was written, MAYBE_DIRTY when that happened further up,
// behind a derived.

export let is_destroying_effect = false;

export function set_is_destroying_effect(value: boolean): void {
	is_destroying_effect = value;
}

export let active_reaction: Reaction | null = null;

export let untracking = false;

export function set_active_reaction(reaction: Reaction | null): void {
	active_reaction = reaction;
}

export let active_effect: Effect | null = null;

export function set_active_effect(effect: Effect | null): void {
	active_effect = effect;
}

/**
 * When sources are created within a reaction, reading and writing
 * them within that reaction should not cause a re-run
 */
export let current_sources: Set<Value> | null = null;

/**
 * With `experimental.async`, an effect does depend on the state it creates. svelte-lite leaves
 * that feature out and nothing in it sets the flag, so that a bundler takes it to be `false` and
 * this costs nothing. It is read here because Svelte's signals suite sets it to check exactly this
 */
export function push_reaction_value(value: Value): void {
	if (
		!async_mode_flag &&
		active_reaction !== null &&
		(active_reaction.f & REACTION_IS_UPDATING) !== 0
	) {
		(current_sources ??= new Set()).add(value);
	}
}

/**
 * The dependencies of the reaction that is currently being executed. In many cases,
 * the dependencies are unchanged between runs, and so this will be `null` unless
 * and until a new dependency is accessed — we track this via `skipped_deps`
 */
let new_deps: Value[] | null = null;

let skipped_deps = 0;

/**
 * Used by sources and deriveds for handling updates.
 * Version starts from 1 so that unowned deriveds differentiate between a created effect and a run one for tracing
 **/
export let write_version = 1;

/** Used to version each read of a source of derived to avoid duplicating dependencies inside a reaction */
let read_version = 0;

export let update_version = read_version;

export function set_update_version(value: number): void {
	update_version = value;
}

export function increment_write_version(): number {
	return ++write_version;
}

/**
 * Whether `getAbortSignal()` has been called. Only then does a reaction have a signal to abort
 * when it runs again or is destroyed. Nothing else sets this, so that a bundler can tell that
 * an app without `getAbortSignal()` never gets to `abort_signal`, and leaves it out
 */
export let has_abort_signals = false;

/**
 * The signal of the run of `reaction` that is in progress, which aborts when the
 * reaction runs again or is destroyed (see `getAbortSignal`)
 */
export function get_abort_signal(reaction: Reaction): AbortSignal {
	has_abort_signals = true;

	return (reaction.ac ??= new AbortController()).signal;
}

/**
 * Abort the signal that the last run of `reaction` asked for.
 * Returns whether it had done so
 */
export function abort_signal(reaction: Reaction): boolean {
	var controller = reaction.ac;

	if (!controller) return false;

	reaction.ac = null;
	without_reactive_context(() => controller!.abort(STALE_REACTION));

	return true;
}

/**
 * Determines whether a derived or effect is dirty.
 * If it is MAYBE_DIRTY, will set the status to CLEAN
 */
export function is_dirty(reaction: Reaction): boolean {
	var flags = reaction.f;

	if ((flags & DIRTY) !== 0) {
		return true;
	}

	if ((flags & MAYBE_DIRTY) !== 0) {
		var deps = reaction.deps;

		if (deps !== null) {
			for (var i = 0; i < deps.length; i++) {
				var dep = deps[i];

				// (a source is never marked, so this is `false` for it right away)
				if (has_deriveds && is_dirty(dep as Derived)) {
					update_derived(dep as Derived);
				}

				if (dep.wv > reaction.wv) {
					return true;
				}
			}
		}

		// a derived that nothing listens to is not told about changes, so it is checked on every read
		if ((flags & CONNECTED) !== 0) {
			set_signal_status(reaction, CLEAN);
		}
	}

	return false;
}

export function update_reaction(reaction: Reaction): any {
	var previous_deps = new_deps;
	var previous_skipped_deps = skipped_deps;
	var previous_reaction = active_reaction;
	var previous_sources = current_sources;
	var previous_component_context = component_context;
	var previous_untracking = untracking;
	var previous_update_version = update_version;

	// (the casts keep these from being narrowed to `null`: running the reaction assigns them)
	new_deps = null as Value[] | null;
	skipped_deps = 0;
	active_reaction = (reaction.f & (BRANCH_EFFECT | ROOT_EFFECT)) === 0 ? reaction : null;
	current_sources = null;
	set_component_context(reaction.ctx);
	untracking = false;
	update_version = ++read_version;

	if (has_abort_signals) {
		abort_signal(reaction);
	}

	try {
		reaction.f |= REACTION_IS_UPDATING;
		// (not `reaction.fn()`, which would hand it the reaction as `this`)
		var fn = reaction.fn as Function;
		var result = fn();
		reaction.f = (reaction.f | REACTION_RAN) & ~ERROR_VALUE;
		update_dependencies(reaction);

		// If we are returning to an previous reaction then
		// we need to increment the read version to ensure that
		// any dependencies in this reaction aren't marked with
		// the same version
		if (previous_reaction !== null && previous_reaction !== reaction) {
			read_version++;

			// update the `rv` of the previous reaction's deps — both existing and new —
			// so that they are not added again
			if (previous_reaction.deps !== null) {
				for (var i = 0; i < previous_skipped_deps; i += 1) {
					previous_reaction.deps[i].rv = read_version;
				}
			}

			if (previous_deps !== null) {
				for (var dep of previous_deps) {
					dep.rv = read_version;
				}
			}
		}

		return result;
	} catch (error) {
		// still commit the deps read before the throw, otherwise deriveds connected by this run
		// keep no reader and the reaction never re-runs when they change
		update_dependencies(reaction);

		// For a derived, the error is the value of the run, which `get` throws
		// — unless an error boundary takes care of it
		reaction.f |= ERROR_VALUE;

		var value = handle_error(error);

		if (value !== error) {
			reaction.f ^= ERROR_VALUE;
		}

		return value;
	} finally {
		reaction.f ^= REACTION_IS_UPDATING;
		new_deps = previous_deps;
		skipped_deps = previous_skipped_deps;
		active_reaction = previous_reaction;
		current_sources = previous_sources;
		set_component_context(previous_component_context);
		untracking = previous_untracking;
		update_version = previous_update_version;
	}
}

/**
 * Make what the run that just ended read the dependencies of `reaction`: the first
 * `skipped_deps` of its previous ones, followed by `new_deps`
 */
function update_dependencies(reaction: Reaction): void {
	var deps = reaction.deps;

	// nothing changed
	if (new_deps === null && (deps === null || skipped_deps === deps.length)) {
		return;
	}

	remove_reactions(reaction, skipped_deps);

	if (deps !== null) {
		deps.length = skipped_deps;
	}

	// (the reaction is among the reactions of its new dependencies already, see `get`)
	if (new_deps !== null) {
		if (deps === null || skipped_deps === 0) {
			reaction.deps = new_deps;
		} else {
			for (var dep of new_deps) deps.push(dep);
		}
	}

	// An effect can be destroyed while it runs, e.g. by an error boundary. That took it out of the
	// reactions of what it read in its previous run, and this does for what it has read in this one
	if ((reaction.f & DESTROYED) !== 0) {
		new_deps = null;
		remove_reactions(reaction, 0);
		reaction.deps = null;
	}
}

function remove_reaction(signal: Reaction, dependency: Value): void {
	let reactions = dependency.reactions;
	if (reactions !== null) {
		var index = index_of.call(reactions, signal);
		if (index !== -1) {
			var new_length = reactions.length - 1;
			if (new_length === 0) {
				reactions = dependency.reactions = null;
			} else {
				// Swap with last element and then remove.
				reactions[index] = reactions[new_length];
				reactions.pop();
			}
		}
	}

	// If the derived has no reactions, then we can disconnect it from the graph,
	// allowing it to either reconnect in the future, or be GC'd by the VM.
	if (
		has_deriveds &&
		reactions === null &&
		(dependency.f & DERIVED) !== 0 &&
		// Destroying a child effect while updating a parent effect can cause a dependency to appear
		// to be unused, when in fact it is used by the currently-updating parent. Checking `new_deps`
		// allows us to skip the expensive work of disconnecting and immediately reconnecting it
		(new_deps === null || !includes.call(new_deps, dependency))
	) {
		var derived = dependency as Derived;

		derived.f &= ~CONNECTED;

		// a derived that never ran stays DIRTY, so that it runs once someone wants its value
		if (derived.v !== UNINITIALIZED) {
			update_derived_status(derived);
		}

		// Nobody is listening to this derived anymore. If its signal aborts, it runs again the next
		// time it is read, instead of returning what may be the rejected promise of an aborted fetch
		if (has_abort_signals && abort_signal(derived)) {
			set_signal_status(derived, DIRTY);
		}

		// freeze any effects inside this derived
		freeze_derived_effects(derived);

		// Disconnect any reactions owned by this reaction
		remove_reactions(derived, 0);
	}
}

export function remove_reactions(signal: Reaction, start_index: number): void {
	var dependencies = signal.deps;
	if (dependencies === null) return;

	for (var i = start_index; i < dependencies.length; i++) {
		remove_reaction(signal, dependencies[i]);
	}
}

export function update_effect(effect: Effect): void {
	var flags = effect.f;

	if ((flags & DESTROYED) !== 0) {
		return;
	}

	set_signal_status(effect, CLEAN);

	var previous_effect = active_effect;

	active_effect = effect;

	if (DEV) {
		var previous_component_fn: any = dev_current_component_function;
		set_dev_current_component_function(effect.component_function);
		var previous_stack: any = dev_stack;
		// only block effects have a dev stack, keep the current one otherwise
		set_dev_stack(effect.dev_stack ?? dev_stack);
	}

	try {
		if ((flags & (BLOCK_EFFECT | MANAGED_EFFECT)) !== 0) {
			destroy_block_effect_children(effect);
		} else {
			destroy_effect_children(effect);
		}

		execute_effect_teardown(effect);
		var teardown = update_reaction(effect);
		effect.teardown = typeof teardown === 'function' ? teardown : null;
		effect.wv = write_version;

		// In DEV, increment versions of any sources that were written to during the effect,
		// so that they are correctly marked as dirty when the effect re-runs
		if (DEV && tracing_mode_flag && (effect.f & DIRTY) !== 0 && effect.deps !== null) {
			for (var dep of effect.deps) {
				if (dep.set_during_effect) {
					dep.wv = increment_write_version();
					dep.set_during_effect = false;
				}
			}
		}
	} finally {
		active_effect = previous_effect;

		if (DEV) {
			set_dev_current_component_function(previous_component_fn);
			set_dev_stack(previous_stack);
		}
	}
}

/**
 * Returns a promise that resolves once any pending state changes have been applied.
 */
export async function tick(): Promise<void> {
	await Promise.resolve();

	// By calling flushSync we guarantee that any pending state changes are applied after one tick.
	flushSync();
}

/**
 * Returns a promise that resolves once any state changes, and asynchronous work resulting from them,
 * have resolved and the DOM has been updated. Without `experimental.async` nothing a state change
 * causes is asynchronous, so this is `tick`
 * @since 5.36
 */
export function settled(): Promise<void> {
	return tick();
}

export function get<V>(signal: Value<V>): V {
	// Register the dependency on the current reaction signal.
	if (
		active_reaction !== null &&
		!untracking &&
		(active_reaction.f & REACTION_IS_UPDATING) !== 0 &&
		(current_sources === null || !current_sources.has(signal)) &&
		signal.rv < read_version
	) {
		signal.rv = read_version;

		// If the signal is accessing the same dependencies in the same
		// order as it did last time, increment `skipped_deps`
		// rather than updating `new_deps`, which creates GC cost
		if (new_deps === null && active_reaction.deps?.[skipped_deps] === signal) {
			skipped_deps++;
		} else {
			(new_deps ??= []).push(signal);

			// The reaction is one of the signal's reactions from here on, and not only once it is
			// done: a write to the signal while the reaction still runs marks it, like a write to
			// what it read in its previous run does. An effect that reads state and then writes it
			// runs again (`$effect(() => count++)`).
			// (a derived that nothing listens to does not listen either, see `remove_reaction`)
			if ((active_reaction.f & CONNECTED) !== 0) {
				(signal.reactions ??= []).push(active_reaction);
			}
		}
	}

	if (DEV) {
		if (
			tracing_mode_flag &&
			!untracking &&
			tracing_expressions !== null &&
			active_reaction !== null &&
			tracing_expressions.reaction === active_reaction
		) {
			// Used when mapping state between special blocks like `each`
			if (signal.trace) {
				signal.trace();
			} else {
				var trace = get_error('traced at');

				if (trace) {
					var entry = tracing_expressions.entries.get(signal);

					if (entry === undefined) {
						entry = { traces: [] };
						tracing_expressions.entries.set(signal, entry);
					}

					var last = entry.traces[entry.traces.length - 1];

					// traces can be duplicated, e.g. by `snapshot` invoking both
					// both `getOwnPropertyDescriptor` and `get` traps at once
					if (trace.stack !== last?.stack) {
						entry.traces.push(trace);
					}
				}
			}
		}
	}

	if (has_deriveds && (signal.f & DERIVED) !== 0) {
		var derived = signal as Derived<V>;

		// connect disconnected deriveds when reading them inside a connected reaction
		var should_connect =
			(derived.f & CONNECTED) === 0 &&
			!untracking &&
			active_reaction !== null &&
			(active_reaction.f & CONNECTED) !== 0;

		var is_new = (derived.f & REACTION_RAN) === 0;

		if (is_dirty(derived)) {
			if (should_connect) {
				// set the flag before `update_derived`, so that the derived
				// is added as a reaction to its dependencies
				derived.f |= CONNECTED;
			}

			update_derived(derived);
		}

		if (should_connect && !is_new) {
			unfreeze_derived_effects(derived);
			reconnect(derived);
		}

		// (only the value of a derived can be an error, see `update_reaction`)
		if ((derived.f & ERROR_VALUE) !== 0) {
			throw derived.v;
		}
	}

	return signal.v;
}

/**
 * (Re)connect a disconnected derived, so that it is notified
 * of changes in `mark_reactions`
 */
function reconnect(derived: Derived): void {
	derived.f |= CONNECTED;

	if (derived.deps === null) return;

	for (const dep of derived.deps) {
		var reactions = (dep.reactions ??= []);

		// (the derived is there already if it just ran and read `dep` for the first time)
		if (!includes.call(reactions, derived)) {
			reactions.push(derived);
		}

		if ((dep.f & DERIVED) !== 0 && (dep.f & CONNECTED) === 0) {
			unfreeze_derived_effects(dep as Derived);
			reconnect(dep as Derived);
		}
	}
}

/**
 * Like `get`, but checks for `undefined`. Used for `var` declarations because they can be accessed before being declared
 */
export function safe_get<V>(signal: Value<V> | undefined): V | undefined {
	return signal && get(signal);
}

/**
 * When used inside a [`$derived`](https://svelte.dev/docs/svelte/$derived) or [`$effect`](https://svelte.dev/docs/svelte/$effect),
 * any state read inside `fn` will not be treated as a dependency.
 *
 * ```ts
 * $effect(() => {
 *   // this will run when `data` changes, but not when `time` changes
 *   save(data, {
 *     timestamp: untrack(() => time)
 *   });
 * });
 * ```
 */
export function untrack<T>(fn: () => T): T {
	var previous_untracking = untracking;
	try {
		untracking = true;
		return fn();
	} finally {
		untracking = previous_untracking;
	}
}

/**
 * Possibly traverse an object and read all its properties so that they're all reactive in case this is `$state`.
 * Does only check first level of an object for performance reasons (heuristic should be good for 99% of all cases).
 */
export function deep_read_state(value: any): void {
	if (typeof value !== 'object' || !value || value instanceof EventTarget) {
		return;
	}

	if (STATE_SYMBOL in value) {
		deep_read(value);
	} else if (!Array.isArray(value)) {
		for (let key in value) {
			const prop = value[key];
			if (typeof prop === 'object' && prop && STATE_SYMBOL in prop) {
				deep_read(prop);
			}
		}
	}
}

/**
 * Deeply traverse an object and read all its properties
 * so that they're all reactive in case this is `$state`
 */
export function deep_read(value: any, visited: Set<any> = new Set()): void {
	if (
		typeof value === 'object' &&
		value !== null &&
		// We don't want to traverse DOM elements
		!(value instanceof EventTarget) &&
		!visited.has(value)
	) {
		visited.add(value);
		// When working with a possible SvelteDate, this
		// will ensure we capture changes to it.
		if (value instanceof Date) {
			value.getTime();
		}
		for (let key in value) {
			try {
				deep_read(value[key], visited);
			} catch (e) {
				// continue
			}
		}
		const proto = get_prototype_of(value);
		if (
			proto !== Object.prototype &&
			proto !== Array.prototype &&
			proto !== Map.prototype &&
			proto !== Set.prototype &&
			proto !== Date.prototype
		) {
			const descriptors = get_descriptors(proto);
			for (let key in descriptors) {
				const get = descriptors[key].get;
				if (get) {
					try {
						get.call(value);
					} catch (e) {
						// continue
					}
				}
			}
		}
	}
}
