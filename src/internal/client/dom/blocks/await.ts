import type { Effect, Source, TemplateNode } from '../../types.ts';
import { DEV } from 'esm-env';
import { HYDRATION_START_ELSE, UNINITIALIZED } from '../../../../constants.ts';
import { is_promise } from '../../../shared/utils.ts';
import { ASYNC, DESTROYED, EFFECT_PRESERVED } from '../../constants.ts';
import { capture, unset_context } from '../../reactivity/async.ts';
import { Batch, current_batch, flushSync, is_flushing_sync } from '../../reactivity/batch.ts';
import { block } from '../../reactivity/effects.ts';
import { internal_set, source } from '../../reactivity/sources.ts';
import { active_effect } from '../../runtime.ts';
import {
	hydrate_next,
	hydrating,
	set_hydrate_node,
	set_hydrating,
	skip_nodes
} from '../hydration.ts';
import { queue_micro_task } from '../task.ts';
import { BranchManager } from './branches.ts';

const PENDING = 0;
const THEN = 1;
const CATCH = 2;

type AwaitState = typeof PENDING | typeof THEN | typeof CATCH;

export function await_block<V>(
	node: TemplateNode,
	get_input: () => any,
	pending_fn: null | ((anchor: Node) => void),
	then_fn: null | ((anchor: Node, value: Source<V>) => void),
	catch_fn: null | ((anchor: Node, error: unknown) => void)
): void {
	if (hydrating) {
		hydrate_next();
	}

	var value = source(UNINITIALIZED as V);
	var error = source<unknown>(UNINITIALIZED);

	// Flagged like the result of an async expression, as in Svelte: the scheduler notes it
	// with every write to them, and `$inspect.trace` reports them as `$derived`
	value.f |= ASYNC;
	error.f |= ASYNC;

	if (DEV) {
		value.label = '{#await ...} value';
		error.label = '{#await ...} error';
	}

	var branches = new BranchManager<AwaitState>(node);

	/** The latest run of the block. A promise that settles after a later run is ignored */
	var current = {};

	block(() => {
		var effect = active_effect as Effect;
		var batch = current_batch as Batch;
		var input = get_input();
		var run = (current = {});

		/** Whether or not there was a hydration mismatch. Needs to be a `let` or else it isn't treeshaken out */
		let mismatch = hydrating && is_promise(input) === (node.nodeValue === HYDRATION_START_ELSE);

		if (mismatch) {
			// Hydration mismatch: remove everything inside the anchor and start fresh
			set_hydrate_node(skip_nodes());
			set_hydrating(false);
		}

		if (is_promise(input)) {
			var restore = capture();
			var resolved = false;

			const resolve = (fn: () => void) => {
				if ((effect.f & DESTROYED) !== 0 || run !== current) return;

				resolved = true;

				// The context of the block is restored, but not its batch: the pending,
				// resolved and failed states are each their own batch, so to speak
				restore(null);

				// ...but the batch that the block ran in can still be the current one here, if the promise is
				// a thenable that settles right away, or if that batch has not been flushed yet
				if (current_batch === batch) {
					batch.deactivate();
				}

				// Make sure we have a batch, since the branch manager expects one to exist
				Batch.ensure();

				try {
					fn();
				} finally {
					unset_context(false);

					// without this, the DOM does not update until two ticks after the promise
					// resolves, which is unexpected behaviour (and somewhat irksome to test)
					if (!is_flushing_sync) flushSync();
				}
			};

			input.then(
				(v) => {
					resolve(() => {
						internal_set(value, v as V);
						branches.ensure(THEN, then_fn && ((target) => then_fn(target, value)));
					});
				},
				(e) => {
					resolve(() => {
						internal_set(error, e);
						branches.ensure(CATCH, catch_fn && ((target) => catch_fn(target, error)));

						if (!catch_fn) {
							// Rethrow the error if no catch block exists
							throw e;
						}
					});
				}
			);

			if (hydrating) {
				branches.ensure(PENDING, pending_fn);
			} else {
				// Wait a microtask before checking if we should show the pending state as
				// the promise might have resolved by then
				queue_micro_task(() => {
					if (!resolved) {
						resolve(() => {
							branches.ensure(PENDING, pending_fn);
						});
					}
				});
			}
		} else {
			internal_set(value, input);
			branches.ensure(THEN, then_fn && ((target) => then_fn(target, value)));
		}

		if (mismatch) {
			// continue in hydration mode
			set_hydrating(true);
		}
	}, EFFECT_PRESERVED); // states are selected asynchronously: keep the effect even without dependencies
}
