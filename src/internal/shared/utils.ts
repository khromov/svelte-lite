// Store the references to globals in case someone tries to monkey patch these, causing the below
// to de-opt (this occurs often when using popular extensions).
export var is_array = Array.isArray;
export var index_of = Array.prototype.indexOf;
export var includes = Array.prototype.includes;
export var array_from = Array.from;
export var object_keys = Object.keys;
export var define_property = Object.defineProperty;
export var get_descriptor = Object.getOwnPropertyDescriptor;
export var get_descriptors = Object.getOwnPropertyDescriptors;
export var object_prototype = Object.prototype;
export var array_prototype = Array.prototype;
export var get_prototype_of = Object.getPrototypeOf;
export var is_extensible = Object.isExtensible;
export var has_own_property = Object.prototype.hasOwnProperty;

export function is_function(thing: any): thing is Function {
	return typeof thing === 'function';
}

export const noop = () => {};

// Adapted from https://github.com/then/is-promise/blob/master/index.js
// Distributed under MIT License https://github.com/then/is-promise/blob/master/LICENSE

export function is_promise<T = any>(value: any): value is PromiseLike<T> {
	return typeof value?.then === 'function';
}

export function run(fn: Function) {
	return fn();
}

export function run_all(arr: Array<() => void>) {
	for (var i = 0; i < arr.length; i++) {
		arr[i]();
	}
}

/**
 * `array.push(...items)` overflows the stack for large `items`.
 */
export function push_array<T>(array: T[], items: T[]) {
	for (var i = 0; i < items.length; i++) {
		array.push(items[i]);
	}
}

/**
 * TODO replace with Promise.withResolvers once supported widely enough
 */
export function deferred<T = void>() {
	var resolve!: (value: T) => void;
	var reject!: (reason: any) => void;

	var promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}

export function fallback<V>(value: V, fallback: V | (() => V), lazy = false): V {
	return value === undefined ? (lazy ? (fallback as () => V)() : (fallback as V)) : value;
}

/**
 * When encountering a situation like `let [a, b, c] = $derived(blah())`,
 * we need to stash an intermediate value that `a`, `b`, and `c` derive
 * from, in case it's an iterable
 */
export function to_array<T>(value: ArrayLike<T> | Iterable<T>, n?: number): Array<T> {
	// return arrays unchanged
	if (Array.isArray(value)) {
		return value;
	}

	// if value is not iterable, or `n` is unspecified (indicates a rest
	// element, which means we're not concerned about unbounded iterables)
	// convert to an array with `Array.from`
	if (n === undefined || !(Symbol.iterator in value)) {
		return Array.from(value);
	}

	// otherwise, populate an array with `n` values

	const array: T[] = [];

	for (const element of value as Iterable<T>) {
		array.push(element);
		if (array.length === n) break;
	}

	return array;
}

export function exclude_from_object(
	obj: Record<string | symbol, unknown>,
	keys: Array<string | symbol>
): Record<string | symbol, unknown> {
	var result: Record<string | symbol, unknown> = {};

	for (var key in obj) {
		if (!keys.includes(key)) {
			result[key] = obj[key];
		}
	}

	for (var symbol of Object.getOwnPropertySymbols(obj)) {
		if (Object.propertyIsEnumerable.call(obj, symbol) && !keys.includes(symbol)) {
			result[symbol] = obj[symbol];
		}
	}

	return result;
}
