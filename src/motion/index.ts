// Imported through the package and not by path, so that the conditions in `exports` pick the
// server's `MediaQuery` on the server. The client's one calls `window.matchMedia` as soon as
// it is constructed, which is when this module loads.
import { MediaQuery } from 'svelte/reactivity';

export * from './spring.ts';
export * from './tweened.ts';
export type { SpringOptions, SpringUpdateOptions, TweenOptions, Tweened, Updater } from './public.ts';

/**
 * A [media query](https://svelte.dev/docs/svelte/svelte-reactivity#MediaQuery) that matches if the user [prefers reduced motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion).
 *
 * ```svelte
 * <script>
 * 	import { prefersReducedMotion } from 'svelte/motion';
 * 	import { fly } from 'svelte/transition';
 *
 * 	let visible = $state(false);
 * </script>
 *
 * <button onclick={() => visible = !visible}>
 * 	toggle
 * </button>
 *
 * {#if visible}
 * 	<p transition:fly={{ y: prefersReducedMotion.current ? 0 : 200 }}>
 * 		flies in, unless the user prefers reduced motion
 * 	</p>
 * {/if}
 * ```
 * @since 5.7.0
 */
export const prefersReducedMotion: MediaQuery = /*@__PURE__*/ new MediaQuery(
	'(prefers-reduced-motion: reduce)'
);
