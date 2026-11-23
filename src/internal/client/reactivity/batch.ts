import type { Fork } from '../../../index.ts';
import type { Effect, Value } from '../types.ts';
import {
	BLOCK_EFFECT,
	BRANCH_EFFECT,
	CLEAN,
	DESTROYED,
	EFFECT,
	INERT,
	ROOT_EFFECT
} from '../constants.ts';
import { define_property } from '../../shared/utils.ts';
import { has_abort_signals, is_dirty, update_effect } from '../runtime.ts';
import * as e from '../errors.ts';
import { flush_tasks, queue_micro_task } from '../dom/task.ts';
import { DEV } from 'esm-env';
import { invoke_error_boundary } from '../error-handling.ts';
import { has_effects, unlink_effect } from './effects.ts';
import { set_signal_status } from './status.ts';
import { unsupported } from '../../../unsupported.ts';

// The scheduler. It is synchronous: a write changes the value there and then, marks what depends
// on it and schedules the effects among that. Nothing else happens until the flush, in a microtask
// or in `flushSync`, which brings the effect tree up to date in two steps that repeat until nothing
// is scheduled anymore:
//
// 1. `traverse` walks the trees that have something scheduled inside, in the order the effects
//    were created, and runs the ones that render: block effects, template effects, `$effect.pre`.
//    The `$effect`s it passes are collected
// 2. `flush_effects` runs those, now that the DOM is up to date
//
// Svelte has a batch object per flush that holds the values of that flush, so that several can be
// in flight at once. That serves `experimental.async`, which svelte-lite leaves out, so there is
// no such object here, only the module's own state.

/** Whether `flushSync` is running */
export let is_flushing_sync = false;

/** Whether a flush is queued or running */
let is_scheduled = false;

/** The roots of the effect trees that have something scheduled inside */
let queued_root_effects: Effect[] = [];

/**
 * During traversal, this is an array. Newly created effects are (if not immediately
 * executed) pushed to this array, rather than going through the scheduling
 * rigamarole that would cause another turn of the flush loop.
 */
export let collected_effects: Effect[] | null = null;

/**
 * While the effects of a flush run, this is an array of the block effects that the one
 * that is running made dirty. They run right after it (see `flush_effects`)
 */
export let eager_block_effects: Effect[] | null = null;

let last_scheduled_effect: Effect | null = null;

/** Sources whose DEV update counts and stack traces need resetting after the flush. */
export const source_stacks = new Set<Value>();

/**
 * Make sure that a flush is on its way
 */
export function schedule_flush(): void {
	if (!is_scheduled) {
		is_scheduled = true;
		queue_micro_task(flush);
	}
}

/**
 * Note that `effect` has to run, by marking the way to it from the root of its tree: every
 * branch on that way loses its CLEAN flag, which is what the traversal follows
 */
export function schedule_effect(effect: Effect): void {
	schedule_flush();

	last_scheduled_effect = effect;

	while (effect.parent !== null) {
		effect = effect.parent;
		var flags = effect.f;

		if ((flags & (ROOT_EFFECT | BRANCH_EFFECT)) !== 0) {
			// the rest of the way is marked already
			if ((flags & CLEAN) === 0) return;
			effect.f &= ~CLEAN;
		}
	}

	queued_root_effects.push(effect);
}

function flush(): void {
	// flushes can be nested, e.g. if an effect calls `flushSync`
	var previously_collected_effects = collected_effects;
	var roots: Effect[] = [];

	try {
		var flush_count = 0;

		while (queued_root_effects.length > 0) {
			if (flush_count++ > 1000) {
				infinite_loop_guard();
			}

			roots = queued_root_effects;
			queued_root_effects = [];

			var effects: Effect[] = (collected_effects = []);

			for (var root of roots) {
				traverse(root, effects);
			}

			collected_effects = null;

			if (has_effects) {
				flush_effects(effects);
			}
		}
	} catch (error) {
		// leave no marks behind: a branch that is marked is taken to be queued already
		for (root of roots.concat(queued_root_effects)) {
			reset_all(root);
		}

		queued_root_effects = [];

		throw error;
	} finally {
		is_scheduled = false;
		last_scheduled_effect = null;
		collected_effects = previously_collected_effects;

		if (DEV) {
			for (const source of source_stacks) {
				source.updated = null;
			}

			source_stacks.clear();
		}
	}
}

/**
 * Traverse the effect tree, executing effects or stashing
 * them for later execution as appropriate
 */
function traverse(root: Effect, effects: Effect[]): void {
	root.f |= CLEAN;

	var effect = root.first;

	while (effect !== null) {
		var flags = effect.f;
		var is_branch = (flags & (BRANCH_EFFECT | ROOT_EFFECT)) !== 0;

		// a clean branch has nothing scheduled inside, and what is paused does not update
		if (!(is_branch && (flags & CLEAN) !== 0) && (flags & INERT) === 0) {
			if (is_branch) {
				effect.f |= CLEAN;
			} else if ((flags & EFFECT) !== 0) {
				effects.push(effect);
			} else if (is_dirty(effect)) {
				update_effect(effect);
			}

			var child = effect.first;

			if (child !== null) {
				effect = child;
				continue;
			}
		}

		while (effect !== null) {
			var next = effect.next;

			if (next !== null) {
				effect = next;
				break;
			}

			effect = effect.parent;
		}
	}
}

function flush_effects(effects: Effect[]): void {
	try {
		// Only the effects that are marked by now run in this turn. What they mark, by writing to
		// state, waits for the next turn, by which time the DOM is up to date again
		for (var effect of effects.filter(is_marked)) {
			if ((effect.f & (DESTROYED | INERT)) === 0 && is_dirty(effect)) {
				var blocks: Effect[] = (eager_block_effects = []);

				update_effect(effect);

				// Effects with no dependencies or teardown do not get added to the effect tree.
				// Deferred effects (e.g. `$effect(...)`) _are_ added to the tree because we
				// don't know if we need to keep them until they are executed. Doing the check
				// here (rather than in `update_effect`) allows us to skip the work for
				// immediate effects.
				if (
					effect.deps === null &&
					effect.first === null &&
					effect.nodes === null &&
					effect.teardown === null &&
					// (its signal aborts when it is destroyed, for which it has to be found)
					!(has_abort_signals && effect.ac)
				) {
					// remove this effect from the graph
					unlink_effect(effect);
				}

				// If the effect wrote to state that a block depends on, the block runs before the next
				// effect does, which may be inside a branch that the block is about to remove.
				// (The array grows if a block makes other blocks dirty)
				for (var i = 0; i < blocks.length; i++) {
					update_block(blocks[i]);
				}
			}
		}
	} finally {
		eager_block_effects = null;
	}
}

function is_marked(effect: Effect): boolean {
	return (effect.f & CLEAN) === 0;
}

/**
 * Run a block effect that an effect made dirty, after the block effects around it
 * that are dirty too: they may be about to remove it
 */
function update_block(effect: Effect | null): void {
	if (effect !== null) {
		update_block(effect.parent);

		if ((effect.f & (BLOCK_EFFECT | CLEAN | DESTROYED | INERT)) === BLOCK_EFFECT) {
			update_effect(effect);
		}
	}
}

/**
 * Mark an entire effect tree clean following an error
 */
function reset_all(effect: Effect): void {
	set_signal_status(effect, CLEAN);

	var e = effect.first;
	while (e !== null) {
		reset_all(e);
		e = e.next;
	}
}

function infinite_loop_guard(): void {
	if (DEV) {
		var updates = new Map<string, { error: Error; count: number }>();

		for (const source of source_stacks) {
			for (const [stack, update] of source.updated ?? []) {
				var entry = updates.get(stack);

				if (!entry) {
					entry = { error: update.error, count: 0 };
					updates.set(stack, entry);
				}

				entry.count += update.count;
			}
		}

		for (const update of updates.values()) {
			if (update.error) {
				// eslint-disable-next-line no-console
				console.error(update.error);
			}
		}
	}

	try {
		e.effect_update_depth_exceeded();
	} catch (error) {
		if (DEV) {
			// stack contains no useful information, replace it
			define_property(error, 'stack', { value: '' });
		}

		// Best effort: invoke the boundary nearest the most recent
		// effect and hope that it's relevant to the infinite loop
		invoke_error_boundary(error, last_scheduled_effect);
	}
}

/**
 * Synchronously flush any pending updates.
 * Returns void if no callback is provided, otherwise returns the result of calling the callback.
 */
export function flushSync<T = void>(fn?: (() => T) | undefined): T {
	var was_flushing_sync = is_flushing_sync;
	is_flushing_sync = true;

	try {
		var result;

		if (fn) {
			flushSync(); // flush anything pending through the while loop below

			result = fn();
		}

		while (true) {
			flush_tasks();

			if (queued_root_effects.length === 0) {
				return result as T;
			}

			flush();
		}
	} finally {
		is_flushing_sync = was_flushing_sync;
	}
}

/**
 * Implementation of `$state.eager(fn())`. In Svelte it gives the value as it is now where the
 * rest of the UI is held back until asynchronous work is done. Nothing is held back without
 * `experimental.async`, so the value as it is now is all there is
 */
export function eager<T>(fn: () => T): T {
	return fn();
}

/**
 * Creates a 'fork', in which state changes are evaluated but not applied to the DOM.
 * It is part of `experimental.async`, which svelte-lite leaves out
 *
 * @since 5.42
 */
export function fork(fn: () => void): Fork {
	unsupported('`fork`, which needs `experimental.async`');
}

/**
 * Svelte's test suite calls this between tests to remove the batches that are left.
 * There are none to remove here
 */
export function clear(): void {}
