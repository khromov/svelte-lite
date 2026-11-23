import type {
	Readable,
	StartStopNotifier,
	Subscriber,
	Unsubscriber,
	Updater,
	Writable
} from '../public.ts';
import type { Stores, StoresValues, SubscribeInvalidateTuple } from '../private.ts';
import { safe_not_equal } from '../../internal/client/reactivity/equality.ts';
import { noop, run_all } from '../../internal/shared/utils.ts';
import { subscribe_to_store } from '../utils.ts';

/** Subscribers that have yet to be called, each followed by the value to call it with */
const subscriber_queue: Array<SubscribeInvalidateTuple<any> | any> = [];

/**
 * Creates a `Readable` store that allows reading by subscription.
 *
 * @param value initial value
 */
export function readable<T>(value?: T, start?: StartStopNotifier<T>): Readable<T> {
	return {
		subscribe: writable(value, start).subscribe
	};
}

/**
 * Create a `Writable` store that allows both updating and reading by subscription.
 *
 * @param value initial value
 */
export function writable<T>(value?: T, start: StartStopNotifier<T> = noop): Writable<T> {
	let stop: Unsubscriber | null = null;

	const subscribers = new Set<SubscribeInvalidateTuple<T>>();

	function set(new_value: T): void {
		if (safe_not_equal(value, new_value)) {
			value = new_value;
			if (stop) {
				// store is ready
				const run_queue = !subscriber_queue.length;
				for (const subscriber of subscribers) {
					subscriber[1]();
					subscriber_queue.push(subscriber, value);
				}
				if (run_queue) {
					for (let i = 0; i < subscriber_queue.length; i += 2) {
						subscriber_queue[i][0](subscriber_queue[i + 1]);
					}
					subscriber_queue.length = 0;
				}
			}
		}
	}

	function update(fn: Updater<T>): void {
		set(fn(value as T));
	}

	function subscribe(run: Subscriber<T>, invalidate: () => void = noop): Unsubscriber {
		const subscriber: SubscribeInvalidateTuple<T> = [run, invalidate];
		subscribers.add(subscriber);
		if (subscribers.size === 1) {
			stop = start(set, update) || noop;
		}
		run(value as T);
		return () => {
			subscribers.delete(subscriber);
			if (subscribers.size === 0 && stop) {
				stop();
				stop = null;
			}
		};
	}

	return { set, update, subscribe };
}

/**
 * Derived value store by synchronizing one or more readable stores and
 * applying an aggregation function over its input values.
 */
export function derived<S extends Stores, T>(
	stores: S,
	fn: (
		values: StoresValues<S>,
		set: (value: T) => void,
		update: (fn: Updater<T>) => void
	) => Unsubscriber | void,
	initial_value?: T
): Readable<T>;
/**
 * Derived value store by synchronizing one or more readable stores and
 * applying an aggregation function over its input values.
 */
export function derived<S extends Stores, T>(
	stores: S,
	fn: (values: StoresValues<S>) => T,
	initial_value?: T
): Readable<T>;
export function derived<S extends Stores, T>(
	stores: S,
	fn: Function,
	initial_value?: T
): Readable<T> {
	const single = !Array.isArray(stores);
	const stores_array: Array<Readable<any>> = single ? [stores] : stores;
	if (!stores_array.every(Boolean)) {
		throw new Error('derived() expects stores as input, got a falsy value');
	}
	const auto = fn.length < 2;
	return readable(initial_value, (set, update) => {
		let started = false;
		const values: T[] = [];
		let pending = 0;
		let cleanup = noop;
		const sync = () => {
			if (pending) {
				return;
			}
			cleanup();
			const result = fn(single ? values[0] : values, set, update);
			if (auto) {
				set(result);
			} else {
				cleanup = typeof result === 'function' ? result : noop;
			}
		};
		const unsubscribers = stores_array.map((store, i) =>
			subscribe_to_store(
				store,
				(value) => {
					values[i] = value;
					pending &= ~(1 << i);
					if (started) {
						sync();
					}
				},
				() => {
					pending |= 1 << i;
				}
			)
		);
		started = true;
		sync();
		return function stop() {
			run_all(unsubscribers);
			cleanup();
			// We need to set this to false because callbacks can still happen despite having unsubscribed:
			// Callbacks might already be placed in the queue which doesn't know it should no longer
			// invoke this derived store.
			started = false;
		};
	});
}

/**
 * Takes a store and returns a new one derived from the old one that is readable.
 *
 * @param store store to make readonly
 */
export function readonly<T>(store: Readable<T>): Readable<T> {
	return {
		// `subscribe` is declared to not use `this`, but a store that is an instance of a class may
		subscribe: (store.subscribe as Function).bind(store)
	};
}

/**
 * Get the current value from a store by subscribing and immediately unsubscribing.
 */
export function get<T>(store: Readable<T>): T {
	let value: T | undefined;
	subscribe_to_store(store, (_) => (value = _))();
	return value as T;
}
