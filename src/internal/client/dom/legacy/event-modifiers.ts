// The `once` modifier of an `on:` directive on a component, `<Child on:done|once={handler}>`,
// which compiles to `$.once(handler)`. svelte-lite rejects `on:` when compiling (see
// check/index.ts), and the modifiers of `on:` on an element are gone.

type Handler = (event: Event, ...args: unknown[]) => void;

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
