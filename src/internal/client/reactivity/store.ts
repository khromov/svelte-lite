import type { Source, StoreReferencesContainer } from '../types.ts';
import type { Store } from '../../shared/types.ts';
import { DEV } from 'esm-env';
import { get as get_store } from '../../../store/shared/index.ts';
import { subscribe_to_store } from '../../../store/utils.ts';
import { define_property, noop } from '../../shared/utils.ts';
import { get } from '../runtime.ts';
import { teardown } from './effects.ts';
import { safe_equals } from './equality.ts';
import { set, source } from './sources.ts';

/**
 * Whether or not the prop currently being read is a store binding, as in
 * `<Child bind:x={$y} />`. If it is, we treat the prop as mutable even in
 * runes mode, and skip `binding_property_non_reactive` validation
 */
let is_store_binding = false;

let IS_UNMOUNTED = Symbol('unmounted');

/**
 * The signal that holds the value of a store. Like the store itself, it notifies when it is
 * set to the object or function that it already holds, which may have been mutated
 */
function store_source(): Source<any> {
	const s = source<any>(undefined);
	s.equals = safe_equals;
	return s;
}

/**
 * Gets the current value of a store. If the store isn't subscribed to yet, it will create a proxy
 * signal that will be updated when the store is. The store references container is needed to
 * track reassignments to stores and to track the correct component context.
 */
export function store_get<V>(
	store: Store<V> | null | undefined,
	store_name: string,
	stores: StoreReferencesContainer
): V {
	const entry = (stores[store_name] ??= {
		store: null,
		source: store_source(),
		unsubscribe: noop
	});

	if (DEV) {
		entry.source.label = store_name;
	}

	// if the component that setup this is already unmounted we don't want to register a subscription
	if (entry.store !== store && !(IS_UNMOUNTED in stores)) {
		entry.unsubscribe();
		entry.store = store ?? null;

		if (store == null) {
			entry.source.v = undefined; // see synchronous callback comment below
			entry.unsubscribe = noop;
		} else {
			var is_synchronous_callback = true;

			entry.unsubscribe = subscribe_to_store(store, (v) => {
				if (is_synchronous_callback) {
					// If the first updates to the store value (possibly multiple of them) are synchronously
					// inside a derived, we will hit the `state_unsafe_mutation` error if we `set` the value
					entry.source.v = v;
				} else {
					set(entry.source, v);
				}
			});

			is_synchronous_callback = false;
		}
	}

	// if the component that setup this stores is already unmounted the source will be out of sync
	// so we just use the `get` for the stores, less performant but it avoids to create a memory leak
	// and it will keep the value consistent
	if (store && IS_UNMOUNTED in stores) {
		return get_store(store);
	}

	return get(entry.source);
}

/**
 * Unsubscribe from a store if it's not the same as the one in the store references container.
 * We need this in addition to `store_get` because someone could unsubscribe from a store but
 * then never subscribe to the new one (if any), causing the subscription to stay open wrongfully.
 */
export function store_unsub<S extends Store<any> | null | undefined>(
	store: S,
	store_name: string,
	stores: StoreReferencesContainer
): S {
	let entry = stores[store_name] as StoreReferencesContainer[string] | undefined;

	if (entry && entry.store !== store) {
		// Don't reset store yet, so that store_get above can resubscribe to new store if necessary
		entry.unsubscribe();
		entry.unsubscribe = noop;
	}

	return store;
}

/**
 * Sets the new value of a store and returns that value.
 */
export function store_set<V>(store: Store<V>, value: V): V {
	store.set(value);
	return value;
}

export function invalidate_store(stores: StoreReferencesContainer, store_name: string) {
	var entry = stores[store_name];
	if (entry.store !== null) {
		store_set(entry.store, entry.source.v);
	}
}

/**
 * Unsubscribes from all auto-subscribed stores on destroy
 */
export function setup_stores(): [StoreReferencesContainer, () => void] {
	const stores: StoreReferencesContainer = {};

	function cleanup() {
		teardown(() => {
			for (var store_name in stores) {
				const ref = stores[store_name];
				ref.unsubscribe();
			}
			define_property(stores, IS_UNMOUNTED, {
				enumerable: false,
				value: true
			});
		});
	}

	return [stores, cleanup];
}

/**
 * Updates a store with a new value.
 * @param store the store to update
 * @param expression the expression that mutates the store
 * @param new_value the new store value
 */
export function store_mutate<V>(store: Store<V>, expression: any, new_value: V) {
	store.set(new_value);
	return expression;
}

export function update_store(store: Store<number>, store_value: number, d: 1 | -1 = 1): number {
	store.set(store_value + d);
	return store_value;
}

export function update_pre_store(store: Store<number>, store_value: number, d: 1 | -1 = 1): number {
	const value = store_value + d;
	store.set(value);
	return value;
}

/**
 * Called inside prop getters to communicate that the prop is a store binding
 */
export function mark_store_binding() {
	is_store_binding = true;
}

/**
 * Returns a tuple that indicates whether `fn()` reads a prop that is a store binding.
 * Used to prevent `binding_property_non_reactive` validation false positives and
 * ensure that these props are treated as mutable even in runes mode
 */
export function capture_store_binding<T>(fn: () => T): [T, boolean] {
	var previous_is_store_binding = is_store_binding;

	try {
		is_store_binding = false;
		return [fn(), is_store_binding];
	} finally {
		is_store_binding = previous_is_store_binding;
	}
}
