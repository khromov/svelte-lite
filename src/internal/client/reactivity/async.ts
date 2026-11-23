import type { Effect, Source, Value } from '../types.ts';
import type { Batch } from './batch.ts';
import { DESTROYED } from '../constants.ts';
import { DEV } from 'esm-env';
import { component_context, dev_stack, set_component_context, set_dev_stack } from '../context.ts';
import {
	active_effect,
	active_reaction,
	set_active_effect,
	set_active_reaction
} from '../runtime.ts';
import { current_batch } from './batch.ts';
import { reactivity_loss_tracker, derived, set_reactivity_loss_tracker } from './deriveds.ts';
import { unsupported } from '../../../unsupported.ts';

// This module is where Svelte keeps what `await` needs in a component: in its script (`run`,
// `wait` and the blockers they produce), in its template (`flatten` waiting for expressions)
// and in `$derived` (`save`). All of that requires `experimental.async`, which svelte-lite
// leaves out. What remains is what other features use as well, and the names that
// `internal/client/index` re-exports, which throw.

const ASYNC = '`experimental.async` in the browser';

/**
 * A step of a component script that `await`s at the top level, which the parts of the
 * template that depend on it wait for. Nothing creates one without `experimental.async`
 */
export interface Blocker {
	promise: Promise<any>;
	settled: boolean;
	failed: boolean;
}

/**
 * Creates a derived for each of the `sync` expressions and calls `fn` with them.
 *
 * In Svelte this also waits for `blockers` and for the `async` expressions. Both only have
 * content with `experimental.async`. They are parameters because the callers, which get
 * them from the compiler by position, pass them on.
 */
export function flatten(
	blockers: Blocker[],
	sync: Array<() => any>,
	async: Array<() => Promise<any>>,
	fn: (values: Value[]) => any
): void {
	var deriveds = sync.map(derived);

	if (DEV) {
		deriveds.forEach((d, i) => {
			// TODO this is kinda useful for debugging but a lousy implementation —
			// maybe the compiler could pass through the template string
			d.label = sync[i]
				.toString()
				.replace('() => ', '')
				.replaceAll('$.eager(() => ', '$state.eager(')
				.replace(/\$\.get\((.+?)\)/g, (_, id) => id);
		});
	}

	fn(deriveds);
}

export function run_after_blockers(blockers: Blocker[], fn: (values: Value[]) => any): void {
	flatten(blockers, [], [], fn);
}

/**
 * Captures the current effect context so that we can restore it after
 * some asynchronous work has happened (so that e.g. `await a + b`
 * causes `b` to be registered as a dependency).
 */
export function capture(): (batch?: Batch | null) => void {
	var previous_effect = active_effect as Effect;
	var previous_reaction = active_reaction;
	var previous_component_context = component_context;
	var previous_batch = current_batch as Batch;

	if (DEV) {
		var previous_dev_stack = dev_stack;
	}

	/**
	 * @param batch the batch to continue in, if not the one that was active before
	 */
	return function restore(batch = previous_batch) {
		set_active_effect(previous_effect);
		set_active_reaction(previous_reaction);
		set_component_context(previous_component_context);

		if (batch !== null && (previous_effect.f & DESTROYED) === 0) {
			// A batch that was merged into another one continues as that one.
			// TODO we only need the check here because `{#await ...}` blocks
			// are anomalous. Once we retire them we can get rid of it
			merge_target(batch).activate();
		}

		if (DEV) {
			set_reactivity_loss_tracker(null);
			set_dev_stack(previous_dev_stack);
		}
	};
}

/**
 * Wraps an `await` expression in a template or a `$derived`, so that the effect context can
 * be reapplied afterwards. See the note at the top: the name is all that is left
 */
export function save(): never {
	unsupported(ASYNC);
}

/** Ends what `save` started. See the note at the top */
export function unsave(): never {
	unsupported(ASYNC);
}

/**
 * Reset `current_async_effect` after the `promise` resolves, so
 * that we can emit `await_reactivity_loss` warnings.
 * The compiler wraps every `await` of a component in this in dev mode, with or without
 * `experimental.async`
 */
export async function track_reactivity_loss<T>(promise: Promise<T>): Promise<() => T> {
	var previous_reactivity_loss_tracker = reactivity_loss_tracker;
	// Ensure that unrelated reads after an async operation is kicked off don't cause false positives
	queueMicrotask(() => {
		if (reactivity_loss_tracker === previous_reactivity_loss_tracker) {
			set_reactivity_loss_tracker(null);
		}
	});

	var value = await promise;

	return () => {
		set_reactivity_loss_tracker(previous_reactivity_loss_tracker);
		// While this can result in false negatives it also guards against the more important
		// false positives that would occur if this is the last in a chain of async operations,
		// and the reactivity_loss_tracker would then stay around until the next async operation happens.
		queueMicrotask(() => {
			if (reactivity_loss_tracker === previous_reactivity_loss_tracker) {
				set_reactivity_loss_tracker(null);
			}
		});

		return value;
	};
}

/**
 * Used in `for await` loops in DEV, so
 * that we can emit `await_reactivity_loss` warnings
 * after each `async_iterator` result resolves and
 * after the `async_iterator` return resolves (if it runs)
 */
export async function* for_await_track_reactivity_loss<T, TReturn>(
	iterable: Iterable<T> | AsyncIterable<T>
): AsyncGenerator<T, TReturn | undefined> {
	// This is based on the algorithms described in ECMA-262:
	// ForIn/OfBodyEvaluation
	// https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-runtime-semantics-forin-div-ofbodyevaluation-lhs-stmt-iterator-lhskind-labelset
	// AsyncIteratorClose
	// https://tc39.es/ecma262/multipage/abstract-operations.html#sec-asynciteratorclose

	const iterator: AsyncIterator<T, TReturn> =
		// @ts-ignore
		iterable[Symbol.asyncIterator]?.() ?? iterable[Symbol.iterator]?.();

	if (iterator === undefined) {
		throw new TypeError('value is not async iterable');
	}

	// eslint-disable-next-line no-useless-assignment
	let invoke_return = true;

	try {
		while (true) {
			const { done, value } = (await track_reactivity_loss(iterator.next()))();
			if (done) {
				invoke_return = false;
				break;
			}
			var prev = reactivity_loss_tracker;
			try {
				yield value;
			} catch (e) {
				set_reactivity_loss_tracker(prev);
				// If the yield throws, we need to call `return` but not return its value, instead rethrow
				if (iterator.return !== undefined) {
					(await track_reactivity_loss(iterator.return()))();
				}
				throw e;
			}
			set_reactivity_loss_tracker(prev);
		}
	} catch (error) {
		invoke_return = false;
		throw error;
	} finally {
		// If the iterator had an abrupt completion (break) and `return` is defined on the iterator, call it and return the value
		if (invoke_return && iterator.return !== undefined) {
			// eslint-disable-next-line no-unsafe-finally
			return (await track_reactivity_loss(iterator.return()))().value as TReturn;
		}
	}
}

export function unset_context(deactivate_batch = true): void {
	set_active_effect(null);
	set_active_reaction(null);
	set_component_context(null);
	if (deactivate_batch) current_batch?.deactivate();

	if (DEV) {
		set_reactivity_loss_tracker(null);
		set_dev_stack(null);
	}
}

/**
 * The state of a component script that `await`s at the top level, as `reactivity/deriveds`
 * reads it while one of the script's steps runs
 */
interface Runner {
	/** Callbacks to run after the script resumes */
	continued: Array<() => void>;
	/** Async deriveds created during this run */
	signals: Source[];
	/** Whether the full initialization promise chain is still pending. */
	running: boolean;
	/** The batch to continue in, even if the original fork was discarded. */
	get_batch(): Batch;
	restore(): void;
	/** Switch away from the previous batch (which is now obsolete) to another one */
	switch(batch: Batch): void;
}

/**
 * The script's state while a `run` step executes. Without `run` there are no steps, so this
 * is always `null`. It is exported because `reactivity/deriveds` reads it
 */
export const current_runner: Runner | null = null;

/** Runs a component script that `await`s at the top level. See the note at the top */
export function run(): never {
	unsupported(ASYNC);
}

/** Waits for the steps of `run`. See the note at the top */
export function wait(): never {
	unsupported(ASYNC);
}

/**
 * Adds pending work to the current batch, and to the boundary of the active effect. If the batch is merged
 * into another one before the work is done, it's that batch's from then on (see `Batch#merge`).
 * Only work that `await`s is ever pending. This is what `reactivity/deriveds` calls for it
 */
export function increment_pending(): () => void {
	var effect = active_effect as Effect;
	var boundary = effect.b; // undefined if called outside the render tree, e.g. a standalone $effect.root
	var batch = merge_target(current_batch as Batch);

	/** The nearest boundary with a pending snippet, if there is one */
	var pending = boundary;

	while (pending && !pending.is_pending) {
		pending = pending.parent;
	}

	batch.increment(effect);
	pending?.increment(effect, batch);
	boundary?.update_effect_pending(1);

	return () => {
		merge_target(batch).decrement(effect);
		// The boundary keeps counts under the originating batch, even if it was merged.
		pending?.decrement(effect, batch);
		boundary?.update_effect_pending(-1);
	};
}

/**
 * The batch that `batch` was merged into, if any (transitively), else `batch` itself
 */
export function merge_target(batch: Batch): Batch {
	while (batch.merged !== null) batch = batch.merged;
	return batch;
}
