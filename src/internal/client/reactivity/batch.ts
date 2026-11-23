import type { Fork } from '../../../index.ts';
import type {
	BatchRecord,
	BatchValue,
	Derived,
	DerivedRecord,
	EachState,
	Effect,
	Reaction,
	Source,
	Value
} from '../types.ts';
import type { Boundary } from '../dom/blocks/boundary.ts';
import {
	BLOCK_EFFECT,
	BRANCH_EFFECT,
	CLEAN,
	DESTROYED,
	DIRTY,
	EFFECT,
	INERT,
	RENDER_EFFECT,
	ROOT_EFFECT,
	MAYBE_DIRTY,
	DERIVED,
	EAGER_EFFECT,
	ERROR_VALUE,
	MANAGED_EFFECT,
	REACTION_RAN,
	DESTROYING,
	EFFECT_OFFSCREEN,
	ASSIGNED,
	ASYNC,
	REACTION_IS_UPDATING,
	BOUNDARY_EFFECT
} from '../constants.ts';
import { async_mode_flag } from '../../flags/index.ts';
import { deferred, define_property } from '../../shared/utils.ts';
import {
	active_effect,
	active_reaction,
	get,
	increment_write_version,
	is_destroying_effect,
	is_dirty,
	is_outdated,
	promote_record,
	prune_edges,
	untrack,
	update_effect,
	write_version,
	abort_record
} from '../runtime.ts';
import * as e from '../errors.ts';
import { flush_tasks, queue_micro_task } from '../dom/task.ts';
import { DEV } from 'esm-env';
import { invoke_error_boundary } from '../error-handling.ts';
import {
	eager_effects,
	eager_effects_deferred,
	flush_eager_effects,
	source,
	update
} from './sources.ts';
import { eager_effect, teardown, unlink_effect } from './effects.ts';
import { UNINITIALIZED } from '../../../constants.ts';
import { set_signal_status, update_derived_status } from './status.ts';
import { invariant } from '../../shared/dev.ts';
import { OBSOLETE } from './deriveds.ts';
import { merge_target } from './async.ts';
import { unsupported } from '../../../unsupported.ts';

export let first_batch: Batch | null = null;

let last_batch: Batch | null = null;

export let current_batch: Batch | null = null;

/**
 * The batch currently being processed (see `#process`)
 */
export let processing_batch: Batch | null = null;

export type TeardownContext = {
	/**
	 * What teardowns see instead of the values sources hold: the values from before the writes that caused
	 * the teardowns (the `previous` of the batch being processed, see `flush`). For block effects that re-run
	 * right away because of a user effect's writes, also the writes of the effects that ran before it in the
	 * same commit, which apply (see `flush_queued_effects`)
	 */
	reverted_values: Map<Value, BatchValue>;
	/** The values of deriveds in this view (see `runtime.js#teardown_view`), until it changes */
	derived_cache: Map<Derived, BatchValue>;
	/** The context to restore after a nested flush or eager block */
	parent: TeardownContext | null;
};

/**
 * Effect teardowns revert the writes that caused them (see `runtime.js#teardown_view`).
 * (A teardown outside of a flush reverts nothing, but gets a context to cache its deriveds in, for as long as it
 * runs — see `execute_effect_teardown`)
 */
export let teardown_context: TeardownContext | null = null;

export function set_teardown_context(context: TeardownContext | null): void {
	teardown_context = context;
}

export function push_teardown_context(values?: Map<Value, BatchValue>): TeardownContext {
	var context: TeardownContext = (teardown_context = {
		reverted_values: new Map(teardown_context?.reverted_values),
		derived_cache: new Map(),
		parent: teardown_context
	});

	for (const [source, value] of values ?? []) context.reverted_values.set(source, value);

	return context;
}

/**
 * A write in a teardown remains visible after returning to an enclosing teardown view,
 * and the deriveds that teardowns evaluated may depend on it
 */
export function teardown_write(source: Value): void {
	for (var context = teardown_context; context !== null; context = context.parent) {
		context.reverted_values.delete(source);
		context.derived_cache.clear();
	}
}

/**
 * When time travelling (i.e. working in one batch, while other batches
 * still have ongoing work), we ignore the real values of affected
 * signals in favour of their values within the batch — along with their
 * versions: the batch's writes, and the values from before the writes of
 * other batches, which its view of the world undoes (see `activate`).
 * `null` means that the real world (i.e. the latest values) applies.
 * Doesn't contain computed deriveds, these are in {@link view_cache}.
 */
export let batch_values: Map<Value, BatchValue> | null = null;

/**
 * The values of deriveds in the active view of the world, for as long as it is active (see `get_view`):
 * a record of a run (in which case `e` tells whether its value is an error), the derived itself if its
 * global state applies, or the write to it that holds (an assignment). Exists whenever `batch_values` does
 */
export let view_cache: Map<Derived, Derived | DerivedRecord | BatchValue> | null = null;

/**
 * The batch whose view of the world is active (see `activate`). Block and async
 * effects that run while it is processed, and deriveds evaluated with values
 * that are not the latest, are recorded in this batch
 */
export let view_batch: Batch | null = null;

let last_scheduled_effect: Effect | null = null;

/**
 * Batches whose view of the world changed because another batch committed, and that
 * therefore need to be processed again once the current flush is done (see `#commit`)
 */
var rebases = new Set<Batch>();

export let is_flushing_sync = false;

/**
 * During traversal, this is an array. Newly created effects are (if not immediately
 * executed) pushed to this array, rather than going through the scheduling
 * rigamarole that would cause another turn of the flush loop.
 */
export let collected_effects: Effect[] | null = null;

/**
 * An array of effects that are marked during traversal as a result of a `set`
 * (not `internal_set`) call. These will be added to the next batch and
 * trigger another `batch.process()`.
 * Svelte marks this as deprecated ("when we get rid of legacy mode and stores, we can get rid
 * of this"). Despite the name it is not specific to legacy mode: every `set` during traversal
 * goes through it, which is why svelte-lite has it
 */
export let legacy_updates: Effect[] | null = null;

var flush_count = 0;

/** Sources whose DEV update counts and stack traces need resetting after the flush. */
export const source_stacks = new Set<Value>();

/**
 * A set of signals we have already seen while traversing in `batch.mark`.
 * Not always set to balance the common case of sources only having a couple
 * of (transitive) dependencies (where always creating a Set would be bad for perf)
 * with the edge case of extremely deep or wide dependency arrays with cycles.
 */
var seen: Set<any> | null = null;
/** Number of transitive dependencies, see {@link seen} for more info */
var count_deps = 0;

let uid = 1;

let last_processed: number | null = null;

type Callbacks = Map<(batch: Batch) => void, Map<Value, BatchValue> | null>;

export class Batch {
	id = uid++;

	/** True as soon as `#process` was called */
	started = false;

	linked = true;

	prev: Batch | null = null;

	next: Batch | null = null;

	async_deriveds = new Map<Effect, ReturnType<typeof deferred<any>>>();

	/**
	 * The current values (and their versions) of any sources that are updated in this batch,
	 * including deriveds that were overridden via assignment — until it commits them (see `#commit`).
	 * Its keys are those of `this.previous`, plus the sources this batch gave their first value. `e` says whether
	 * the value is an error
	 */
	current = new Map<Value, BatchValue>();

	/**
	 * The values (and their versions) of any sources that are updated in this batch _before_ those updates took place.
	 * For a derived, `assigned` says whether its value before was assigned, too (otherwise it was computed).
	 * A source that this batch gave its first value (e.g. an async expression that resolved for the first time) has
	 * no entry: there's no value from before it, so other views can't undo the write, and teardowns don't revert it.
	 */
	previous = new Map<Value, BatchValue>();

	/**
	 * Results of reactions that belong to this batch rather than to the real world:
	 * deriveds evaluated in this batch's view of the world with values that are not the
	 * latest ones, and block/async effects that ran while this batch was processed.
	 * Effect records become global state when the batch commits (see `promote_record`)
	 */
	records: Map<Reaction, BatchRecord> | null = null;

	/**
	 * Earlier batches whose changes are part of this batch's view of the world, because
	 * they intersect with it (this batch will be merged into them, see `#merge`)
	 */
	folded: Batch[] = [];

	/**
	 * When the batch is committed (and the DOM is updated), we need to remove old branches
	 * and append new ones by calling the functions added inside (if/each/key/etc) blocks.
	 * Each callback maps to the writes that apply in the teardowns it causes, if it was added
	 * while block effects re-ran eagerly (see `eager_block_writes`)
	 */
	#commit_callbacks: Callbacks = new Map();

	/**
	 * If a fork is discarded, we need to destroy any effects that are no longer needed
	 * (see `#commit_callbacks`)
	 */
	#discard_callbacks: Callbacks = new Map();

	/**
	 * Async effects that are currently in flight
	 */
	#pending = new Map<Effect, number>();

	/**
	 * A deferred that resolves when the batch is committed, used with `settled()`
	 * TODO replace with Promise.withResolvers once supported widely enough
	 */
	#deferred: {
		promise: Promise<void>;
		resolve: (value?: any) => void;
		reject: (reason: unknown) => void;
	} | null = null;

	/**
	 * Effects to (re-)validate when this batch is processed next, and their status (DIRTY or MAYBE_DIRTY):
	 * those that were scheduled while it wasn't being processed (see {@link schedule}), and those whose run
	 * was deferred because it has pending work (see `#defer_effects`)
	 */
	#unprocessed = new Map<Effect, number>();

	/**
	 * Effects that were scheduled in this batch but not yet 'resolved' into the
	 * root effects that need to be flushed. Resolving — the upwards traversal that
	 * marks the path to each effect on the shared effect tree (see #resolve) — is
	 * deferred until the batch is processed, so that the markers are created and
	 * consumed within a single traversal. Scheduling into other batches (which can
	 * happen concurrently, e.g. while a batch is committed) can therefore never
	 * observe (and be confused by) this batch's markers.
	 * May contain duplicates — deduplication happens during resolving
	 */
	#scheduled: Effect[] = [];

	/**
	 * Branches that still exist, but will be destroyed when this batch
	 * is committed — we skip over these during `#process`
	 */
	#skipped_branches = new Set<Effect>();

	/**
	 * Branches that this batch selected (see `unskip_effect`). A branch that is offscreen until
	 * it is committed (see `EFFECT_OFFSCREEN`) only exists in the views of the batches that selected it
	 */
	#unskipped_branches = new Set<Effect>();

	is_fork = false;

	/**
	 * The batch that this one was merged into, if any (see `#merge`). Its async work that is still in flight
	 * continues as part of that one
	 */
	merged: Batch | null = null;

	/**
	 * Batches whose runs this batch aborted. Merge into them before waiting for pending work.
	 * Requests belong to this batch because a synchronous derived can abort outside traversal,
	 * before an unrelated batch is processed (e.g. a fork being committed).
	 */
	merge_requests = new Set<Batch>();

	#decrement_queued = false;

	constructor() {
		if (last_batch === null) {
			first_batch = last_batch = this;
		} else {
			last_batch.next = this;
			this.prev = last_batch;
		}

		last_batch = this;
	}

	#is_deferred(): boolean {
		if (this.is_fork) return true;

		for (const effect of this.#pending.keys()) {
			if (this.is_blocked_by(effect)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Whether `effect` is a branch that this batch skips, or that only exists offscreen for other batches
	 */
	#skips(effect: Effect): boolean {
		return (
			this.#skipped_branches.has(effect) ||
			((effect.f & EFFECT_OFFSCREEN) !== 0 && !this.#unskipped_branches.has(effect))
		);
	}

	/**
	 * Whether `effect` is inside a branch that this batch skips, i.e. doesn't exist in its view of the world
	 */
	is_skipped(effect: Effect): boolean {
		for (var e: Effect | null = effect; e !== null; e = e.parent) {
			if (this.#skips(e)) return true;
		}

		return false;
	}

	/**
	 * Whether async work in `effect` holds up this batch — or, with `root`, the boundary whose content `root` is.
	 * It doesn't if the effect is inside a branch that this batch skips (the branch is going to be destroyed),
	 * or inside a boundary that is pending (which shows its pending snippet in the meantime).
	 * Unlike a skipped branch, the content of a pending boundary does exist in the view of the batch: its
	 * effects are still re-validated (see `#revalidate`), they just don't keep the batch from committing
	 */
	is_blocked_by(effect: Effect, root: Effect | null = null): boolean {
		for (var e: Effect | null = effect; e !== null && e !== root; e = e.parent) {
			if (this.#skips(e)) return false;

			if (
				(e.f & (BOUNDARY_EFFECT | DESTROYED)) === BOUNDARY_EFFECT &&
				(e.b as Boundary).is_pending
			) {
				return false;
			}
		}

		return true;
	}

	skip_effect(effect: Effect): void {
		this.#skipped_branches.add(effect);
		this.#unskipped_branches.delete(effect);
	}

	unskip_effect(effect: Effect): void {
		if (
			this.#skipped_branches.delete(effect) ||
			(!this.#unskipped_branches.has(effect) &&
				((effect.f & EFFECT_OFFSCREEN) !== 0 ||
					this.folded.some((batch) => batch.#skipped_branches.has(effect))))
		) {
			// This batch adopts a branch that it skipped (whose effects may have been reset, see `reset_branch`),
			// that so far only existed offscreen (possibly for another batch, whose view of the world its
			// effects ran in), or that a batch whose writes are part of its view skips (and so didn't run the
			// effects that its writes affect, or reset them) — re-validate its effects in this batch's view
			this.revalidate_branch(effect);
		}

		this.#unskipped_branches.add(effect);
	}

	/**
	 * Like `unskip_effect`, for a branch that was just created offscreen while this batch is processed.
	 * Its effects ran in this batch's view of the world when they were created, so there's nothing to re-validate
	 * TODO can we skip revalidation in `unskip_effect` in more cases, by detecting whether things changed
	 * inside a branch while it was skipped?
	 */
	unskip_new_effect(effect: Effect): void {
		this.#unskipped_branches.add(effect);
	}

	revalidate_branch(effect: Effect): void {
		for (var e = effect.first; e !== null; e = e.next) {
			var flags = e.f;

			// (branches nested inside that exist offscreen for other batches only are not adopted)
			if ((flags & (DESTROYED | INERT)) === 0 && !this.#skips(e)) {
				if ((flags & (BRANCH_EFFECT | ROOT_EFFECT | EAGER_EFFECT)) === 0 && e.fn !== null) {
					this.schedule(e, MAYBE_DIRTY);
				}

				this.revalidate_branch(e);
			}
		}
	}

	/**
	 * Convert the effects that were scheduled in this batch into the root effects
	 * that need to be traversed, marking the path to each effect (by clearing the
	 * `CLEAN` flag on ancestor branches) so that the traversal can find them.
	 * This happens right before traversal rather than at scheduling time, so that
	 * the markers left on the (shared) effect tree are created and consumed within
	 * a single traversal — scheduling into other batches can never observe them
	 */
	#resolve(): Effect[] {
		var roots: Effect[] = [];

		for (const effect of this.#scheduled) {
			// skip effects that are destroyed, or that already ran (e.g. because
			// they were reached by the traversal that preceded a drain iteration,
			// or because they were scheduled twice)
			if ((effect.f & DESTROYED) !== 0 || (effect.f & (DIRTY | MAYBE_DIRTY)) === 0) continue;

			var e = effect;
			var covered = false;

			while (e.parent !== null) {
				e = e.parent;
				var flags = e.f;

				if ((flags & (ROOT_EFFECT | BRANCH_EFFECT)) !== 0) {
					if ((flags & CLEAN) === 0) {
						// the path to the root was already marked, meaning the
						// root was already collected — nothing left to do
						covered = true;
						break;
					}

					e.f ^= CLEAN;
				}
			}

			if (!covered) {
				roots.push(e);
			}
		}

		this.#scheduled = [];

		return roots;
	}

	#process(): void {
		current_batch = processing_batch = this;

		// A different batch view may apply, even when processing continues within the same flush.
		teardown_context?.derived_cache.clear();

		if (async_mode_flag && this.started && last_processed !== this.id) {
			// Since this batch last ran, reactions may have come to depend on its writes without it
			// knowing (e.g. effects created by other batches), or have run in the view of other batches.
			// Re-validate them in this batch's view — this only re-runs those that are out of date
			this.#revalidate(this.current.keys());
		}

		this.started = true;
		last_processed = this.id;

		// Deferred effects are rescheduled even if the batch still has pending work, because traversing the
		// tree could make an if block that contains the last blocking pending effect falsy, causing the batch
		// to no longer be deferred. If it still is, they are deferred again
		if (this.#unprocessed.size > 0) {
			for (const [e, status] of this.#unprocessed) this.#add(e, status);
			this.#unprocessed.clear();
		}

		if (DEV) {
			// track all the values that were updated during this flush,
			// so that they can be reset afterwards
			for (const value of this.current.keys()) {
				source_stacks.add(value);
			}
		}

		this.activate();

		var effects: Effect[] = (collected_effects = []);

		var render_effects: Effect[] = [];

		var revealed_boundaries: Boundary[] = [];

		var updates: Effect[] = (legacy_updates = []);

		// Effects can be scheduled during traversal (e.g. because a parent each/await/etc
		// block updated an internal source, or because an effect invalidated itself)
		// hence we loop until there are no more scheduled effects.
		while (this.#scheduled.length > 0) {
			if (flush_count++ > 1000) {
				this.#unlink();
				infinite_loop_guard(); // TODO try to reset the tree here?
			}

			for (const root of this.#resolve()) {
				try {
					this.#traverse(root, effects, render_effects, revealed_boundaries);
				} catch (e) {
					reset_branch(root, true);
					// If there's no async work left, this branch is now dead and needs
					// to be discarded to not become a zombie that is never cleaned up.
					// See https://github.com/sveltejs/svelte/issues/18221#issuecomment-4497918414
					// for a (non-minimal) reproduction that demonstrates a case where this is necessary
					// to not get follow-up false-positives via "batch has scheduled roots" invariant errors.
					if (!this.#is_deferred()) this.discard();
					throw e;
				}
			}

			if (this.#scheduled.length > 0) {
				// A later traversal may discover effects before ones we already collected.
				// Recollect them together so they are flushed in tree order, rather than
				// appending earlier effects after their later siblings.
				for (const effect of render_effects) this.#scheduled.push(effect);
				for (const effect of effects) this.#scheduled.push(effect);
				render_effects.length = 0;
				effects.length = 0;
			}
		}

		// any writes should take effect in a subsequent batch
		current_batch = null;

		if (updates.length > 0) {
			var batch = Batch.ensure();
			for (const e of updates) {
				// these were marked during traversal already (see `mark_reactions`), unless they ran since
				if ((e.f & CLEAN) === 0) batch.schedule(e, MAYBE_DIRTY);
			}
		}

		collected_effects = null;
		legacy_updates = null;

		if (this.merge_requests.size > 0) {
			const sorted = Array.from(this.merge_requests, merge_target)
				.filter((batch) => batch !== this && batch.linked && !batch.is_fork)
				.sort((a, b) => a.id - b.id);
			this.merge_requests.clear();

			if (sorted.length > 0) {
				this.#defer_effects(render_effects);
				this.#defer_effects(effects);

				var target: Batch = this;
				var i = sorted.length;

				while (i--) {
					var earlier = sorted[i];
					if (earlier === target) continue;
					earlier.#merge(target);
					target = earlier;
				}

				// Revalidate once all the writes and pending work belong to the same batch.
				target.#process();
				return;
			}
		}

		// if the batch has outstanding pending work, stash effects and bail
		if (this.#is_deferred()) {
			this.#defer_effects(render_effects);
			this.#defer_effects(effects);

			for (const e of this.#skipped_branches) {
				reset_branch(e);
			}

			if (updates.length > 0) {
				(current_batch as unknown as Batch).#process();
			}

			return;
		}

		const earlier_batch = this.#find_earlier_batch();

		if (earlier_batch) {
			// If this batch collected deferred effects during traversal, they still need
			// to run after being merged into the earlier batch.
			this.#defer_effects(render_effects);
			this.#defer_effects(effects);
			earlier_batch.#merge(this);
			earlier_batch.#process();

			return;
		}

		for (const boundary of revealed_boundaries) {
			// A later traversal may have restored an unresolved branch since this boundary was queued.
			if (boundary.is_pending && boundary.is_ready(this)) {
				boundary.reveal(effects);
			}
		}

		// The results of this batch are about to become the real-world state
		this.#release_records(true);

		// append/remove branches
		this.#run_callbacks(this.#commit_callbacks);

		var earlier_writes = flush_queued_effects(render_effects);

		flush_queued_effects(effects, earlier_writes);

		this.#deferred?.resolve();

		var next_batch = current_batch as unknown as Batch | null;

		if (this.#pending.size === 0 && (this.#scheduled.length === 0 || next_batch !== null)) {
			this.#unlink();
		}

		// Order matters here - we need to commit and THEN continue flushing new batches, not the other way around,
		// else we could start flushing a new batch and then, if it has pending work, rebase it right afterwards, which is wrong.
		// In sync mode flushSync can cause #commit to wrongfully think that there needs to be a rebase, so we only do it in async mode
		// TODO fix the underlying cause, otherwise this will likely regress when non-async mode is removed
		if (async_mode_flag) {
			this.commit_writes();
		}

		if (next_batch !== null) {
			// The next batch holds the writes made while this one committed, which cause the teardowns that run
			// when it's processed. So teardowns now revert those, and no longer this batch's: of the reverted
			// values, keep those that are the next batch's values from before its writes. (Writes made in teardowns
			// aren't among them, see `teardown_write`, so they stay visible)
			if (teardown_context !== null) {
				for (const [source, snapshot] of teardown_context.reverted_values) {
					if (next_batch.previous.get(source)?.wv !== snapshot.wv) {
						teardown_context.reverted_values.delete(source);
					}
				}
			}

			next_batch.#process();
		}
	}

	/**
	 * Schedule the reactions that (transitively) depend on `sources` for re-validation in this batch.
	 * They are marked MAYBE_DIRTY, which means that they are only re-run if the exact versions
	 * of their dependencies differ from the ones they last saw (in this batch's view of the world)
	 */
	#revalidate(sources: Iterable<Source>): void {
		// deriveds added during iteration are visited too, so this doubles as a worklist
		var values = new Set<Value>(sources);

		var effects = new Set<Effect>();

		for (const value of values) {
			var reactions = value.reactions;
			if (reactions === null) continue;

			for (const reaction of reactions) {
				var flags = reaction.f;

				if ((flags & DERIVED) !== 0) {
					if ((flags & CLEAN) !== 0) set_signal_status(reaction, MAYBE_DIRTY);
					values.add(reaction as Derived);
					continue;
				}

				var effect = reaction as Effect;
				if (effects.has(effect)) continue;
				effects.add(effect);

				if (
					(flags & (EAGER_EFFECT | INERT | DESTROYED)) === 0 &&
					// branches that this batch skips don't exist in its view of the world
					!this.is_skipped(effect)
				) {
					this.schedule(effect, MAYBE_DIRTY);
				}
			}
		}
	}

	/**
	 * Traverse the effect tree, executing effects or stashing
	 * them for later execution as appropriate
	 */
	#traverse(
		root: Effect,
		effects: Effect[],
		render_effects: Effect[],
		revealed_boundaries: Boundary[]
	): void {
		root.f ^= CLEAN;

		var effect = root.first;

		while (effect !== null) {
			var flags = effect.f;
			var is_branch = (flags & (BRANCH_EFFECT | ROOT_EFFECT)) !== 0;
			var is_skippable_branch = is_branch && (flags & CLEAN) !== 0;

			// (eager effects run in the real world, see `flush_eager_effects`, not in the view of the batch)
			var skip =
				is_skippable_branch || (flags & (INERT | EAGER_EFFECT)) !== 0 || this.#skips(effect);

			if (!skip && effect.fn !== null) {
				if (is_branch) {
					effect.f ^= CLEAN;
				} else if ((flags & EFFECT) !== 0) {
					effects.push(effect);
				} else if (async_mode_flag && (flags & (RENDER_EFFECT | MANAGED_EFFECT)) !== 0) {
					render_effects.push(effect);
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
				// if a pending boundary is now resolved, reveal it
				if ((effect.f & (BOUNDARY_EFFECT | DESTROYED)) === BOUNDARY_EFFECT) {
					var boundary = effect.b as Boundary;

					if (boundary.is_pending && boundary.is_ready(this)) {
						revealed_boundaries.push(boundary);
					}
				}

				var next = effect.next;

				if (next !== null) {
					effect = next;
					break;
				}

				effect = effect.parent;
			}
		}
	}

	#find_earlier_batch(): Batch | null {
		for (var batch = this.prev; batch !== null; batch = batch.prev) {
			if (!batch.is_fork && this.#intersects(batch)) return batch;
		}

		return null;
	}

	#intersects(batch: Batch): boolean {
		for (const source of this.current.keys()) {
			if (batch.current.has(source)) return true;
		}

		return false;
	}

	/**
	 * Take over the writes of a later batch that depends on this one, because it finished first
	 * or aborted one of this batch's runs.
	 * Values it produced (async results, deriveds) remain valid; block effects select their
	 * branches again for this batch, if needed (their selections are keyed by batch)
	 */
	#merge(batch: Batch): void {
		for (const target of batch.merge_requests) this.merge_requests.add(target);
		batch.merge_requests.clear();

		for (const [source, entry] of batch.current) {
			if (!this.previous.has(source)) {
				const previous = batch.previous.get(source);
				if (previous) this.previous.set(source, previous);
			}

			this.current.set(source, entry);
		}

		for (const [effect, deferred] of batch.async_deriveds) {
			const d = this.async_deriveds.get(effect);
			if (d && d !== deferred) deferred.promise.then(d.resolve, d.reject);
			// The incoming run can still be pending. A subsequent replacement must reach
			// this deferred too, not just the older waiters to which it forwards its result.
			this.async_deriveds.set(effect, deferred);
		}

		for (const [reaction, record] of batch.records ?? []) {
			if ((reaction.f & BLOCK_EFFECT) === 0) {
				var replaced = this.records?.get(reaction);
				(this.records ??= new Map()).set(reaction, record);

				// the run moves to this batch
				batch.records?.delete(reaction);

				// (once it's replaced, as both batches may hold the same record, see `keep_global_run`)
				abort_record(reaction, replaced);
			}
		}

		// Clear them or else those that are still pending might get rejected on discard (after merged-into batch is done).
		// This can happen when batch Y merged into X and Y has a pending boundary and therefore still-pending async deriveds inside.
		batch.async_deriveds.clear();

		// That pending work is this batch's from now on: it decrements this batch's counts (see `increment_pending`),
		// so this batch stays linked until the work is done, and receives the effects that a boundary defers until then
		if (batch.#pending.size > 0) {
			for (const [effect, count] of batch.#pending) {
				this.#pending.set(effect, (this.#pending.get(effect) ?? 0) + count);
			}

			batch.#pending.clear();
		}

		if (batch.#unprocessed.size > 0) {
			for (const [effect, status] of batch.#unprocessed) {
				this.#add_dirty_effect(effect, status);
			}

			batch.#unprocessed.clear();
		}

		// What the merged batch did on its own (e.g. branches it selected) is obsolete once this batch is
		// done — whether it commits or is discarded (e.g. because of an error)
		const discard = () => batch.discard();
		this.oncommit(discard);
		this.ondiscard(discard);
		batch.merged = this;
		batch.#unlink();
	}

	/**
	 * Note that `effect` needs to be (re-)validated, without downgrading a DIRTY effect to MAYBE_DIRTY
	 * @param status DIRTY or MAYBE_DIRTY
	 */
	#add_dirty_effect(effect: Effect, status: number): void {
		if (status === DIRTY || this.#unprocessed.get(effect) !== DIRTY) {
			this.#unprocessed.set(effect, status);
		}
	}

	#defer_effects(effects: Effect[]): void {
		for (var i = 0; i < effects.length; i += 1) {
			var effect = effects[i];
			var status = effect.f & (DIRTY | MAYBE_DIRTY);

			if (status !== 0) {
				this.#add_dirty_effect(effect, effect.dv === null ? MAYBE_DIRTY : status);

				// mark as clean so they get scheduled if they depend on pending async state
				set_signal_status(effect, CLEAN);
			}
		}
	}

	/**
	 * Associate a change to a given source with the current
	 * batch, noting its previous and current values (and versions).
	 * The source itself is only updated if this is its latest value, i.e. unless this
	 * is a fork (whose writes only exist in its own view of the world) or a later batch
	 * already wrote to it (e.g. because an async expression resolved in an earlier batch).
	 * @param same whether the value equals the real one (it can, if this batch sees another one, see
	 * `internal_set`) — in which case the source isn't updated, and the value gets the same version
	 * @param error whether the value is an error (thrown when read, see `runtime.js#get`)
	 */
	capture(
		source: Value,
		value: any,
		same: boolean,
		error = false,
		updated_during_traversal: Effect[] | null = null
	): void {
		var previous = this.previous.get(source);
		var later = later_writer(this, source);

		if (previous === undefined) {
			// the value before this batch's change is the one before the later batch's change, if any
			previous = later?.previous.get(source);

			// (A first value has no value from before it, see `previous`. If the later batch's write is the first value,
			// the value before this batch's write is taken to be that one: in the views of other batches and in
			// teardowns, undoing this write then gives the real value, just like not undoing it would)
			if (previous === undefined && source.v !== UNINITIALIZED) {
				previous = {
					v: source.v,
					wv: source.wv,
					e: (source.f & ERROR_VALUE) !== 0,
					assigned: (source.f & ASSIGNED) !== 0
				};
			}

			if (previous !== undefined) this.previous.set(source, previous);
		}

		if (is_destroying_effect) {
			teardown_write(source);
		} else if (previous !== undefined) {
			teardown_context?.reverted_values.set(source, previous);
			teardown_context?.derived_cache.clear();
		}

		var entry: BatchValue = {
			v: value,
			wv: same ? source.wv : increment_write_version(),
			e: error,
			// a write to a derived is an assignment
			assigned: (source.f & DERIVED) !== 0,
			async: (source.f & ASYNC) !== 0
		};

		this.current.set(source, entry);

		// The active view of the world sees writes made while it's active, even if they don't belong to the batch whose
		// view it is — e.g. those of effects that run while a batch commits, which go to a new batch. (Async results
		// are only captured while no view is active, see `async_derived`)
		batch_values?.set(source, entry);

		// an assignment replaces the value of a derived that the active view of the world holds
		view_cache?.delete(source as Derived);

		// in order, this batch's change comes before that of the later batch, which replaces it (this happens when a
		// result arrives in a batch that committed while it was pending, see `#move_to_front`)
		if (!this.is_fork && later !== null) later.previous.set(source, entry);

		if (!this.is_fork && !same && later === null) {
			apply(source, entry);
		}

		// A value that equals the real one, with the same version, changes nothing that reactions
		// could read outside this batch's view — which is revalidated when the batch is processed
		if (!same) {
			seen = null;
			count_deps = 0;
			this.mark(source, DIRTY, updated_during_traversal);
			seen = null;

			if (eager_effects.size > 0 && !eager_effects_deferred) {
				flush_eager_effects();
			}
		}
	}

	deactivate(): void {
		current_batch = processing_batch = batch_values = view_cache = view_batch = null;
	}

	flush(): void {
		// flushes can be nested, e.g. if an effect calls `flushSync`
		var context = push_teardown_context(this.previous);

		try {
			this.#process();

			// (the size check avoids allocating an iterator in the common case)
			if (rebases.size > 0) {
				for (const batch of rebases) {
					rebases.delete(batch);

					// the batch is processed again anyway if a flush is queued
					if (batch.linked && !batch.#decrement_queued) {
						batch.#process();
					}
				}
			}
		} finally {
			flush_count = 0;
			last_scheduled_effect = null;
			collected_effects = null;
			legacy_updates = null;

			teardown_context = context.parent;
			this.deactivate();

			if (DEV) {
				for (const source of source_stacks) {
					source.updated = null;
				}

				source_stacks.clear();
			}
		}
	}

	discard(): void {
		this.#run_callbacks(this.#discard_callbacks);

		for (const deferred of this.async_deriveds.values()) {
			deferred.reject(OBSOLETE);
		}

		this.#unlink();
		this.#deferred?.resolve();
	}

	#commit(): void {
		// If there are other pending batches, they now need to be 'rebased' —
		// in other words, their view of the world now includes the newly committed
		// state (unless the batch in question has a more recent value for a given source),
		// so everything that depends on it needs to be re-validated in their view
		for (let batch = first_batch; batch !== null; batch = batch.next) {
			if (batch === this) continue;

			var is_earlier = batch.id < this.id;

			var sources: Source[] = [];

			for (const [source, entry] of this.current) {
				var own = batch.current.get(source);

				if (own !== undefined) {
					if (is_earlier && entry.v !== own.v && !own.async) {
						// bring the value up to date
						batch.current.set(source, entry);
					} else {
						// same value, later batch has more recent value, or the batch's own result
						// of an async expression — no need to re-run these effects
						continue;
					}
				}

				sources.push(source);
			}

			// If not started yet or no sources to update (which is e.g. possible for the very first batch) then bail
			if (!batch.started || batch.current.size === 0) continue;

			var obsolete = true;

			for (const source of batch.current.keys()) {
				if (!this.current.has(source)) {
					obsolete = false;
					break;
				}
			}

			if (obsolete && is_earlier) {
				// this batch is now obsolete and can be discarded
				batch.discard();
			} else if (sources.length > 0) {
				// The microtask queue can contain the batch already scheduled to run right
				// after this one is finished, so throwing the invariant would be wrong here.
				if (DEV && !batch.#decrement_queued) {
					invariant(batch.#scheduled.length === 0, 'Batch has scheduled effects');
				}

				// Everything that depends on the committed values needs to be re-validated in the
				// batch's view. The batch is processed again once the current flush is done (which
				// also re-validates what depends on its own writes, as the committed batch may have
				// created reactions that read them), so that block effects select their branches
				// and async work restarts in the new view right away
				batch.#revalidate(sources);
				rebases.add(batch);
			}
		}

		// The writes are part of the real world now. A batch that is still linked (because of pending work)
		// only has writes again once that work resolves, which it then commits
		this.current.clear();
		this.previous.clear();
	}

	/**
	 * Make this batch's writes the real world, part of every other batch's view (see `#commit`).
	 * If it has pending work it stays linked, coming first from now on (see `#move_to_front`)
	 */
	commit_writes(): void {
		this.#commit();
		if (this.linked && this.prev !== null) this.#move_to_front();
	}

	increment(effect: Effect): void {
		var count = this.#pending.get(effect) ?? 0;
		this.#pending.set(effect, count + 1);
	}

	decrement(effect: Effect): void {
		var count = this.#pending.get(effect) ?? 0;

		if (count === 1) {
			this.#pending.delete(effect);
		} else {
			this.#pending.set(effect, count - 1);
		}

		if (this.#decrement_queued) return;
		this.#decrement_queued = true;

		queue_micro_task(() => {
			this.#decrement_queued = false;

			if (this.linked) {
				this.flush();
			}
		});
	}

	oncommit(fn: (batch: Batch) => void): void {
		this.#commit_callbacks.set(fn, eager_block_writes?.size ? eager_block_writes : null);
	}

	ondiscard(fn: (batch: Batch) => void): void {
		this.#discard_callbacks.set(fn, eager_block_writes?.size ? eager_block_writes : null);
	}

	/**
	 * Runs the commit/discard callbacks.
	 * A callback that was added while block effects re-ran eagerly detaches the branches that such a run
	 * deselected (see `flush_queued_effects`). The teardowns it causes see the writes that applied in the
	 * run's view, like they would have during the run: of the values that the current teardown context
	 * reverts, the writes of the effects that ran before the one whose writes caused the run are restored.
	 * Callbacks run untracked, because a batch can commit while an effect runs (e.g. one that calls `flushSync`)
	 */
	#run_callbacks(callbacks: Callbacks): void {
		untrack(() => {
			for (const [fn, writes] of callbacks) {
				if (writes === null) {
					fn(this);
					continue;
				}

				var context = push_teardown_context();

				for (const [source, write] of writes) {
					if (context.reverted_values.has(source)) context.reverted_values.set(source, write);
				}

				try {
					fn(this);
				} finally {
					teardown_context = context.parent;
				}
			}
		});

		callbacks.clear();
	}

	settled(): Promise<void> {
		return (this.#deferred ??= deferred()).promise;
	}

	static ensure(): Batch {
		if (current_batch === null) {
			const batch = (current_batch = new Batch());

			if (processing_batch === null && !is_flushing_sync) {
				queue_micro_task(() => {
					if (!batch.started) {
						batch.flush();
					}
				});
			}
		}

		return current_batch;
	}

	/**
	 * Make this the current batch, and its view of the world the active one
	 */
	activate(): void {
		current_batch = this;
		view_batch = this;

		// Async continuations can create or run reactions in another batch's view without
		// processing it. The next flush must re-validate those reactions in its own view.
		if (last_processed !== this.id) last_processed = null;

		if (!async_mode_flag) {
			batch_values = view_cache = null;
			return;
		}

		this.folded = [];

		if (!this.is_fork && this.prev === null && this.next === null) {
			// this batch's view is the real world
			batch_values = view_cache = null;
			return;
		}

		// if there are multiple batches, we are 'time travelling' —
		// we need to override values with the ones in this batch...
		batch_values = new Map(this.current);
		view_cache = new Map();

		// ...and undo changes belonging to other batches unless they intersect
		for (let batch = first_batch; batch !== null; batch = batch.next) {
			if (batch === this || batch.is_fork) continue;

			// Since the latter batch merges into the earlier (if it resolves before the earlier one),
			// we treat the earlier values as "already applied". This way we don't need to rerun async
			// effects of the earlier batch in case they are merged.
			// As a result you can think of batch_values as having the latest values of all intersecting
			// batches up until this batch.
			if (batch.id < this.id && batch.#intersects(this)) {
				this.folded.push(batch);
			} else {
				for (const [source, previous] of batch.previous) {
					// (where the views agree on the value, the real one — and its version — applies. Not for an
					// assigned derived: its value before may have been computed in another view, see `get_view`)
					if (
						!batch_values.has(source) &&
						((source.f & DERIVED) !== 0 || !source.equals(previous.v))
					) {
						batch_values.set(source, previous);
					}
				}
			}
		}
	}

	/**
	 * The record of `reaction` in this batch's view of the world, i.e. that of this batch
	 * or of the (earlier) batches whose changes it includes, if any
	 */
	get_record(reaction: Reaction): BatchRecord | undefined {
		var record = this.records?.get(reaction);
		var i = this.folded.length;

		while (record === undefined && i--) {
			record = this.folded[i].records?.get(reaction);
		}

		return record;
	}

	/**
	 * @param status should be DIRTY or MAYBE_DIRTY
	 */
	mark(signal: Value, status: number, updated_during_traversal: Effect[] | null = null): void {
		var reactions = signal.reactions;
		if (reactions === null) return;

		var length = reactions.length;

		count_deps += length;
		// Activate the `seen` Set if we think from the unusually high number of deps that
		// there might be cycles in the graph, to avoid repeated lookups for reactions
		// Example: https://github.com/sveltejs/svelte/issues/16658 has a graph with one source
		// reaching ~10000 distinct deriveds/effects each, resulting in 65 million walks through repeated visits.
		if (count_deps > 100000 && seen === null) seen = new Set();

		if (seen !== null) {
			if (seen.has(signal)) return;
			seen.add(signal);
		}

		for (var i = 0; i < length; i++) {
			var reaction = reactions[i];
			var flags = reaction.f;

			var not_dirty = (flags & DIRTY) === 0;

			if ((flags & EAGER_EFFECT) !== 0) {
				if (!this.is_fork) {
					// don't set a DIRTY reaction to MAYBE_DIRTY
					if (not_dirty) {
						set_signal_status(reaction, status);
					}

					// Eager effects need to run immediately:
					// - for $inspect so that the stack trace makes sense
					// - for $state.eager because they might be without an effect parent
					eager_effects.add(reaction as Effect);
				}
			} else if ((flags & DERIVED) !== 0) {
				// don't set a DIRTY reaction to MAYBE_DIRTY
				if (not_dirty) {
					set_signal_status(reaction, status);
				}

				var derived = reaction as Derived;

				view_cache?.delete(derived);
				this.mark(derived, MAYBE_DIRTY, updated_during_traversal);
			} else if (not_dirty) {
				var effect = reaction as Effect;

				if ((flags & BLOCK_EFFECT) !== 0 && eager_block_effects !== null) {
					// these run right away to find out which branches the rest of the flush must skip
					// (see `flush_queued_effects`); the DOM changes when this batch commits
					set_signal_status(effect, status);
					eager_block_effects.add(effect);
				}

				if (updated_during_traversal !== null) {
					set_signal_status(effect, status);
					updated_during_traversal.push(effect);
				} else {
					// the status is applied when the batch is processed
					this.schedule(effect, status);
				}
			}
		}
	}

	/**
	 * Schedule `effect` to be (re-)validated when this batch is processed. Its status only applies right
	 * away if this is the batch that the current flush processes (next), or if a reaction is running (which
	 * may have read what changed). Otherwise, whether an effect is dirty depends on this batch's view of the
	 * world, so other batches (which may be processed first) mustn't see it: it is kept with this batch until
	 * it is processed, and then checked against the exact versions of its dependencies (i.e. MAYBE_DIRTY)
	 * @param status DIRTY or MAYBE_DIRTY
	 */
	schedule(effect: Effect, status: number): void {
		last_scheduled_effect = effect;

		// While another batch is committed, effects that this batch's writes affect (other than the one
		// that is running, i.e. writing) wait for it to be processed, rather than running as part of that commit.
		// They may still run as part of it (for that batch's reasons) and see the write, so versions decide — unless
		// the effect is running, in which case it would record the version it didn't see (see `update_dependencies`)
		if (view_batch !== null && view_batch !== this && effect !== active_reaction) {
			this.#add_dirty_effect(
				effect,
				(effect.f & REACTION_IS_UPDATING) !== 0 ? status : MAYBE_DIRTY
			);
			return;
		}

		if (processing_batch !== this && active_reaction === null) {
			if (this.prev !== null || this.next !== null || this.is_fork) {
				this.#add_dirty_effect(effect, MAYBE_DIRTY);
				return;
			}

			status = MAYBE_DIRTY;
		}

		this.#add(effect, status);
	}

	#add(effect: Effect, status: number): void {
		// don't set a DIRTY effect to MAYBE_DIRTY
		if ((effect.f & DIRTY) === 0) {
			set_signal_status(effect, status);
		}

		this.#scheduled.push(effect);
	}

	/** @param commit whether the effects' runs become global state */
	#release_records(commit = false): void {
		var records = this.records;
		if (records === null) return;

		// Release ownership before pruning. Merged runs are retained by the receiving batch
		this.records = null;
		for (const [reaction, record] of records) {
			// A derived's record is a run in this batch's view: it is only the real-world value if its
			// dependencies still hold what it read, which is checked where a record is promoted on read
			// (see `update_derived`) and cannot be checked here. So it is dropped rather than promoted,
			// and its edges are left for its next global run to prune (see `prune_edges`). A destroyed
			// reaction has nothing left to update either
			if ((reaction.f & (DERIVED | DESTROYED)) === 0) {
				// Keep a newer committed async run instead of promoting an outdated record.
				// Otherwise, the effect would rerun and restart its async work in every batch.
				var replaced = (reaction.f & ASYNC) !== 0 && is_outdated(record) && !is_outdated(reaction);

				if (commit && !replaced) {
					promote_record(reaction, record);

					// The committed run is now what applies in the view of every batch without a run of the async
					// effect of its own (typically because the batch committed while its run was pending, inside a
					// pending boundary). Their in-flight runs are superseded: their results would overwrite this one
					// TODO feels pretty hacky and indication of an X-Y problem: This only works because !b.records?.has(reaction)
					// means "this would re-use the real world result, i.e. the one we just committed, so we can reject this old run".
					// This can reject runs too early in pending batches. The superseding batch eventually settles them,
					// but async/if blocks inside pending boundaries should be excluded.
					if ((reaction.f & ASYNC) !== 0) {
						for (let b = first_batch; b !== null; b = b.next) {
							if (b !== this && !b.records?.has(reaction)) {
								b.async_deriveds.get(reaction as Effect)?.reject(OBSOLETE);
							}
						}
					}
				}

				prune_edges(reaction);
			}

			// abort this run - if it was promoted to global, or another batch holds it, too, this is a noop
			abort_record(reaction, record);
		}
	}

	/**
	 * A batch that committed while work inside a pending boundary was in flight stays linked, so that the results
	 * arrive in it. Its writes are the real world now, part of every other batch's view, so it comes first from now
	 * on: This ensures logic about who sees what values in intersects/merge/etc work correctly.
	 */
	#move_to_front(): void {
		var prev = this.prev as Batch;
		var first = first_batch as Batch;

		prev.next = this.next;
		if (this.next === null) last_batch = prev;
		else this.next.prev = prev;

		this.prev = null;
		this.next = first;
		first.prev = first_batch = this;
		this.id = first.id - 1;
	}

	#unlink(): void {
		// #merge calls #unlink, discard later on does it again - prevent
		// running it multiple times to not corrupt the linked list
		if (!this.linked) return;

		var prev = this.prev;
		var next = this.next;

		if (prev === null) {
			first_batch = next;
		} else {
			prev.next = next;
		}

		if (next === null) {
			last_batch = prev;
		} else {
			next.prev = prev;
		}

		this.linked = false;
		this.#release_records();
	}
}

/**
 * Synchronously flush any pending updates.
 * Returns void if no callback is provided, otherwise returns the result of calling the callback.
 */
export function flushSync<T = void>(fn?: (() => T) | undefined): T {
	var was_flushing_sync = is_flushing_sync;
	// e.g. flushSync during effect flushing phase - we gotta restore the view_batch afterwards in that case
	var previous_view_batch = view_batch !== current_batch ? view_batch : null;
	is_flushing_sync = true;

	try {
		var result;

		if (fn) {
			flushSync(); // flush anything pending through the while loop below

			result = fn();
		}

		while (true) {
			flush_tasks();

			if (current_batch === null) {
				return result as T;
			}

			current_batch.flush();
		}
	} finally {
		is_flushing_sync = was_flushing_sync;
		view_batch = previous_view_batch;
	}
}

function infinite_loop_guard(): void {
	if (DEV) {
		var updates = new Map<string, { error: Error; count: number }>();

		for (const source of (current_batch as Batch).current.keys()) {
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

export let eager_block_effects: Set<Effect> | null = null;

/**
 * While block effects re-run eagerly (see `flush_queued_effects`), the writes of the effects that ran before the one
 * whose writes caused the re-runs, which apply in their view (possibly none). `null` otherwise. The branches that
 * these runs select/unskip are only appended (and those they skip detached) when the batch with the writes commits
 * (see `should_defer_append`), and the teardowns that this causes see these writes, too (see `#run_callbacks`)
 */
export let eager_block_writes: Map<Value, BatchValue> | null = null;

/**
 * An effect (as opposed to a render effect, which keeps the offscreen content up to date) inside a boundary
 * that is still pending doesn't run when the batch commits. The boundary keeps it until it is revealed,
 * and hands it to the batch that reveals it (see `Boundary#reveal`)
 * TODO I feel like there's probably a less roundabout way to achieve this
 * @returns whether the effect was deferred
 */
function defer_if_pending(effect: Effect): boolean {
	// A boundary is only pending while its content is new, so an effect that
	// has run before can't be inside one, and we can skip the lookup
	if ((effect.f & (EFFECT | REACTION_RAN)) !== EFFECT) return false;

	for (var boundary = effect.b; boundary !== null; boundary = boundary.parent) {
		if (boundary.is_pending) {
			boundary.defer_effect(effect);
			return true;
		}
	}

	return false;
}

/**
 * `earlier_writes` includes writes from the pre-effect phase. Eager block teardowns
 * revert the running effect's writes, but not these earlier writes.
 */
function flush_queued_effects(
	effects: Array<Effect>,
	earlier_writes: Map<Value, BatchValue> | null = null
): Map<Value, BatchValue> | null {
	var length = effects.length;
	if (length === 0) return earlier_writes;

	var i = 0;

	while (i < length) {
		var effect = effects[i++];

		if (
			(effect.f & (DESTROYED | INERT)) === 0 &&
			// don't run if already marked for destruction in the next batch
			// (this can happen if an effect writes a value which e.g. makes an if block falsy)
			!current_batch?.is_skipped(effect) &&
			!defer_if_pending(effect) &&
			is_dirty(effect)
		) {
			eager_block_effects = new Set();

			var version = write_version;
			update_effect(effect);

			// Effects with no dependencies or teardown do not get added to the effect tree.
			// Deferred effects (e.g. `$effect(...)`) _are_ added to the tree because we
			// don't know if we need to keep them until they are executed. Doing the check
			// here (rather than in `update_effect`) allows us to skip the work for
			// immediate effects.
			if (
				effect.edges === null &&
				effect.first === null &&
				effect.nodes === null &&
				effect.teardown === null &&
				effect.ac === null
			) {
				// remove this effect from the graph
				unlink_effect(effect);
			}

			// If update_effect() has a flushSync() in it, we may have flushed another flush_queued_effects(),
			// which already handled this logic and did set eager_block_effects to null.
			if (eager_block_effects?.size > 0) {
				// these run because of the writes of the effect, so their teardowns revert those
				var previous_teardown_context = teardown_context;

				// if state was written by an effect before the one that caused the eager
				// block rerun, its writes apply in this view. Deriveds must be evaluated
				// afresh rather than reusing results cached before those writes.
				if (earlier_writes !== null) push_teardown_context(earlier_writes);

				// (a copy, as `earlier_writes` grows while the flush continues)
				var previous_eager_block_writes = eager_block_writes;
				eager_block_writes = new Map(earlier_writes);

				try {
					for (const e of eager_block_effects) {
						// Skip eager effects that have already been unmounted, or that are inside a
						// branch that an earlier eager run (e.g. of an ancestor block) skips
						if ((e.f & (DESTROYED | INERT)) !== 0 || current_batch?.is_skipped(e)) continue;

						// Run effects in order from ancestor to descendant, else we could run into nullpointers
						const ordered_effects: Effect[] = [e];
						let ancestor = e.parent;
						while (ancestor !== null) {
							if (eager_block_effects.has(ancestor)) {
								eager_block_effects.delete(ancestor);
								ordered_effects.push(ancestor);
							}
							ancestor = ancestor.parent;
						}

						for (let j = ordered_effects.length - 1; j >= 0; j--) {
							const e = ordered_effects[j];
							// a block run may have skipped/destroyed the branch that a later one is in
							if ((e.f & (DESTROYED | INERT)) !== 0 || current_batch?.is_skipped(e)) continue;
							update_effect(e);
						}
					}
				} finally {
					eager_block_writes = previous_eager_block_writes;
					eager_block_effects?.clear();
					teardown_context = previous_teardown_context;
				}
			}

			// if the effect — or the block effects — wrote anything
			if (write_version !== version && current_batch !== null) {
				for (const [value, write] of current_batch.current) {
					if (write.wv > version) {
						(earlier_writes ??= new Map()).set(value, write);
					}
				}
			}
		}
	}

	eager_block_effects = null;
	return earlier_writes;
}

/**
 * The next batch after `batch` that wrote `source`, if any. Its write comes after one of `batch` in order, so
 * that one isn't the real-world value. Forks are skipped: their writes only exist in their own view of the world
 */
function later_writer(batch: Batch, source: Value): Batch | null {
	var later = batch.next;

	while (later !== null && (later.is_fork || !later.current.has(source))) {
		later = later.next;
	}

	return later;
}

/**
 * Make a write the real-world value of `source`. A write to a derived is an assignment, whose
 * value holds until one of the derived's dependencies is written after it (see `changed_since`)
 */
function apply(source: Value, entry: BatchValue): void {
	source.v = entry.v;
	source.wv = entry.wv;
	source.f = entry.e ? source.f | ERROR_VALUE : source.f & ~ERROR_VALUE;

	if ((source.f & DERIVED) !== 0) {
		source.f |= ASSIGNED;
		update_derived_status(source as Derived);
	}
}

let eager_versions: Source<number>[] = [];

function eager_flush(): void {
	flushSync(() => {
		const eager = eager_versions;
		eager_versions = [];
		for (const version of eager) {
			update(version);
		}
	});
}

var version_map = new Map<Reaction, Source<number>>();

/**
 * Implementation of `$state.eager(fn())`
 */
export function eager<T>(fn: () => T): T {
	var initial = true;
	var value = undefined as T;

	if (active_reaction === null) {
		return fn();
	}

	let parent = active_reaction;

	let version = version_map.get(parent) ?? source(0);
	version_map.set(parent, version);

	if (DEV) {
		version.label ??= '$state.eager version';
	}

	teardown(() => {
		if (parent.f & DESTROYING) version_map.delete(parent);
	});

	get(version);

	// evaluate in the real world — including recording the versions of the dependencies,
	// so that the eager effect is dirty-checked correctly later (see `flush_eager_effects`)
	in_real_world(() => {
		eager_effect(() => {
			if (initial) {
				// the first time this runs, we create an eager effect
				// that will run eagerly whenever the expression changes
				value = fn();
				return;
			}

			// the second time this effect runs, it's to schedule a
			// `version` update. since this will recreate the effect,
			// we don't need to evaluate the expression here
			if (eager_versions.length === 0) {
				queue_micro_task(eager_flush);
			}

			eager_versions.push(version);
		});
	});

	initial = false;

	return value;
}

/**
 * Run `fn` with the real world (i.e. the latest values) as the active view, regardless of which batch is active
 */
export function in_real_world(fn: () => void): void {
	var previous_batch_values = batch_values;
	var previous_view_cache = view_cache;
	var previous_view_batch = view_batch;

	// the real world doesn't belong to a batch, so what runs in it doesn't touch the active batch's records
	batch_values = view_cache = view_batch = null;

	try {
		fn();
	} finally {
		batch_values = previous_batch_values;
		view_cache = previous_view_cache;
		view_batch = previous_view_batch;
	}
}

/**
 * Mark all the effects inside a skipped branch CLEAN, so that they can be correctly
 * rescheduled later (if the branch survives, its effects are re-validated, see `unskip_effect`)
 * @param force reset even clean branches following an error
 */
function reset_branch(effect: Effect, force = false): void {
	// clean branch = nothing dirty inside, no need to traverse further
	if (!force && (effect.f & BRANCH_EFFECT) !== 0 && (effect.f & CLEAN) !== 0) {
		return;
	}

	set_signal_status(effect, CLEAN);

	var e = effect.first;
	while (e !== null) {
		reset_branch(e, force);
		e = e.next;
	}
}

/**
 * Creates a 'fork', in which state changes are evaluated but not applied to the DOM.
 * This is useful for speculatively loading data (for example) when you suspect that
 * the user is about to take some action.
 *
 * Frameworks like SvelteKit can use this to preload data when the user touches or
 * hovers over a link, making any subsequent navigation feel instantaneous.
 *
 * The `fn` parameter is a synchronous function that modifies some state. The
 * state changes will be reverted after the fork is initialised, then reapplied
 * if and when the fork is eventually committed.
 *
 * When it becomes clear that a fork will _not_ be committed (e.g. because the
 * user navigated elsewhere), it must be discarded to avoid leaking memory.
 *
 * svelte-lite leaves out `experimental.async`, which this needs: without it, the first
 * line throws. What follows is kept because Svelte's `signals` tests turn the flag on by
 * hand (`enable_async_mode_flag`) and fork state, to check how the scheduler prunes edges.
 *
 * @since 5.42
 */
export function fork(fn: () => void): Fork {
	if (!async_mode_flag) {
		e.experimental_async_required('fork');
	}

	if (active_effect !== null || current_batch?.is_fork) {
		e.fork_timing();
	}

	var batch = flushSync(() => {
		var batch = Batch.ensure();
		batch.is_fork = true;

		try {
			in_real_world(() => {
				batch_values = new Map();
				view_cache = new Map();
				view_batch = batch;

				fn();
			});
		} catch (error) {
			batch.discard();
			batch.deactivate();
			throw error;
		}

		return batch;
	});

	var settled = batch.settled();
	var committed = false;
	var discarded = false;

	return {
		commit: async () => {
			if (committed) {
				await settled;
				return;
			}

			if (discarded) {
				e.fork_discarded();
			}

			if (!batch.linked) {
				// batch was made obsolete by later changes
				committed = true;
				return;
			}

			committed = true;
			batch.is_fork = false;

			// Apply the changes to the real world. They keep the versions they had in the fork,
			// so that everything the fork computed remains valid (processing the batch
			// re-validates everything that depends on them, see `#process`)
			for (const [source, entry] of batch.current) {
				const later = later_writer(batch, source);

				if (later !== null) {
					// in order, the fork's write comes before the later batch's, which replaces it
					later.previous.set(source, entry);
				} else {
					batch.mark(source, MAYBE_DIRTY);
					apply(source, entry);
				}
			}

			if (eager_effects.size > 0) {
				flush_eager_effects();
			}

			batch.flush();
			await settled;
		},
		discard: () => {
			if (!committed && batch.linked) {
				batch.discard();
			}

			discarded = true;
		}
	};
}

/**
 * Forcibly remove all current batches, to prevent cross-talk between tests
 */
export function clear(): void {
	first_batch = last_batch = null;
}
