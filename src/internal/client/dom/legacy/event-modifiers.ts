// The modifiers of an `on:` directive, which is deprecated and still valid in a runes
// component: `on:click|once|preventDefault={handler}` compiles to `$.once($.preventDefault(handler))`.

type Handler = (event: Event, ...args: unknown[]) => void;

/**
 * Substitute for the `trusted` event modifier
 * @deprecated
 */
export function trusted(fn: Handler): Handler {
	return function (this: unknown, ...args) {
		var event = args[0];
		if (event.isTrusted) {
			fn?.apply(this, args);
		}
	};
}

/**
 * Substitute for the `self` event modifier
 * @deprecated
 */
export function self(fn: Handler): Handler {
	return function (this: unknown, ...args) {
		var event = args[0];
		if (event.target === this) {
			fn?.apply(this, args);
		}
	};
}

/**
 * Substitute for the `stopPropagation` event modifier
 * @deprecated
 */
export function stopPropagation(fn: Handler): Handler {
	return function (this: unknown, ...args) {
		var event = args[0];
		event.stopPropagation();
		return fn?.apply(this, args);
	};
}

/**
 * Substitute for the `once` event modifier
 * @deprecated
 */
export function once(fn: Handler): Handler {
	var ran = false;

	return function (this: unknown, ...args) {
		if (ran) return;
		ran = true;

		return fn?.apply(this, args);
	};
}

/**
 * Substitute for the `stopImmediatePropagation` event modifier
 * @deprecated
 */
export function stopImmediatePropagation(fn: Handler): Handler {
	return function (this: unknown, ...args) {
		var event = args[0];
		event.stopImmediatePropagation();
		return fn?.apply(this, args);
	};
}

/**
 * Substitute for the `preventDefault` event modifier
 * @deprecated
 */
export function preventDefault(fn: Handler): Handler {
	return function (this: unknown, ...args) {
		var event = args[0];
		event.preventDefault();
		return fn?.apply(this, args);
	};
}
