import type { NotFunction } from './internal/types.ts';
// in the order of Svelte's module: the runtime's modules import each other in cycles,
// and this is often the first one an app loads, so it decides in which order they run
import { active_reaction, get_abort_signal, untrack } from './internal/client/runtime.ts';
import { user_effect } from './internal/client/reactivity/effects.ts';
import * as e from './internal/client/errors.ts';
import { component_context } from './internal/client/context.ts';
import { DEV } from 'esm-env';

if (DEV) {
	function throw_rune_error(rune: string) {
		if (!(rune in globalThis)) {
			// TODO if people start adjusting the "this can contain runes" config through v-p-s more, adjust this message
			let value: any; // let's hope no one modifies this global, but belts and braces
			Object.defineProperty(globalThis, rune, {
				configurable: true,
				// eslint-disable-next-line getter-return
				get: () => {
					if (value !== undefined) {
						return value;
					}

					e.rune_outside_svelte(rune);
				},
				set: (v) => {
					value = v;
				}
			});
		}
	}

	throw_rune_error('$state');
	throw_rune_error('$effect');
	throw_rune_error('$derived');
	throw_rune_error('$inspect');
	throw_rune_error('$props');
	throw_rune_error('$bindable');
}

/**
 * Returns an [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal) that aborts when the current [derived](https://svelte.dev/docs/svelte/$derived) or [effect](https://svelte.dev/docs/svelte/$effect) re-runs or is destroyed.
 *
 * Must be called while a derived or effect is running.
 *
 * ```svelte
 * <script>
 * 	import { getAbortSignal } from 'svelte';
 *
 * 	let { id } = $props();
 *
 * 	$effect(() => {
 * 		fetch(`/items/${id}`, { signal: getAbortSignal() }).then(show);
 * 	});
 * </script>
 * ```
 */
export function getAbortSignal(): AbortSignal {
	if (active_reaction === null) {
		e.get_abort_signal_outside_reaction();
	}

	return get_abort_signal(active_reaction);
}

/**
 * `onMount`, like [`$effect`](https://svelte.dev/docs/svelte/$effect), schedules a function to run as soon as the component has been mounted to the DOM.
 * Unlike `$effect`, the provided function only runs once.
 *
 * It must be called during the component's initialisation (but doesn't need to live _inside_ the component;
 * it can be called from an external module). If a function is returned _synchronously_ from `onMount`,
 * it will be called when the component is unmounted.
 *
 * `onMount` functions do not run during [server-side rendering](https://svelte.dev/docs/svelte/svelte-server#render).
 */
export function onMount<T>(
	fn: () => NotFunction<T> | Promise<NotFunction<T>> | (() => any)
): void {
	if (component_context === null) {
		e.lifecycle_outside_component('onMount');
	}

	user_effect(() => {
		const cleanup = untrack(fn);
		if (typeof cleanup === 'function') return cleanup as () => void;
	});
}

/**
 * Schedules a callback to run immediately before the component is unmounted.
 *
 * Out of `onMount` and `onDestroy`, this is the only one that runs inside a server-side
 * component.
 */
export function onDestroy(fn: () => any): void {
	if (component_context === null) {
		e.lifecycle_outside_component('onDestroy');
	}

	onMount(() => () => untrack(fn));
}

// `fork` is part of `experimental.async`, which svelte-lite leaves out. It fails when called
export { flushSync, fork } from './internal/client/reactivity/batch.ts';
export {
	createContext,
	getContext,
	getAllContexts,
	hasContext,
	setContext
} from './internal/client/context.ts';
export { hydratable } from './internal/client/hydratable.ts';
export { hydrate, mount, unmount } from './internal/client/render.ts';
export { tick, untrack, settled } from './internal/client/runtime.ts';
export { createRawSnippet } from './internal/client/dom/blocks/snippet.ts';
