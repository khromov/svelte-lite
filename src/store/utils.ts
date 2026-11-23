import type { Readable } from './public.ts';
import { untrack } from '../internal/client/runtime.ts';
import { noop } from '../internal/shared/utils.ts';

/** What `subscribe` returns: a function for a Svelte store, an object for an RxJS observable */
type Subscription = (() => void) & { unsubscribe?: () => void };

export function subscribe_to_store<T>(
	store: Readable<T> | null | undefined,
	run: (value: T) => void,
	invalidate?: (value: T) => void
): () => void {
	if (store == null) {
		run(undefined as T);

		if (invalidate) invalidate(undefined as T);

		return noop;
	}

	// Svelte store takes a private second argument
	// StartStopNotifier could mutate state, and we want to silence the corresponding validation error
	const unsub: Subscription = untrack(() =>
		store.subscribe(run, invalidate as (() => void) | undefined)
	);

	// Also support RxJS
	return unsub.unsubscribe ? () => unsub.unsubscribe!() : unsub;
}
