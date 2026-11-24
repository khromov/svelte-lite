export interface SpringOptions {
	stiffness?: number;
	damping?: number;
	precision?: number;
}

export interface SpringUpdateOptions {
	instant?: boolean;
	preserveMomentum?: number;
}

export interface TweenOptions<T> {
	delay?: number;
	duration?: number | ((from: T, to: T) => number);
	easing?: (t: number) => number;
	interpolate?: (a: T, b: T) => (t: number) => T;
}

/**
 * A wrapper for a value that behaves in a spring-like fashion. Changes to `spring.target` will cause `spring.current` to
 * move towards it over time, taking account of the `spring.stiffness` and `spring.damping` parameters.
 *
 * ```svelte
 * <script>
 * 	import { Spring } from 'svelte/motion';
 *
 * 	const spring = new Spring(0);
 * </script>
 *
 * <input type="range" bind:value={spring.target} />
 * <input type="range" value={spring.current} disabled />
 * ```
 * @since 5.8.0
 */
export declare class Spring<T> {
	constructor(value: T, options?: SpringOptions);

	/**
	 * Create a spring whose value is bound to the return value of `fn`. This must be called
	 * inside an effect root (for example, during component initialisation).
	 *
	 * ```svelte
	 * <script>
	 * 	import { Spring } from 'svelte/motion';
	 *
	 * 	let { number } = $props();
	 *
	 * 	const spring = Spring.of(() => number);
	 * </script>
	 * ```
	 */
	static of<U>(fn: () => U, options?: SpringOptions): Spring<U>;

	/**
	 * Sets `spring.target` to `value` and returns a `Promise` that resolves if and when `spring.current` catches up to it.
	 *
	 * If `options.instant` is `true`, `spring.current` immediately matches `spring.target`.
	 *
	 * If `options.preserveMomentum` is provided, the spring will continue on its current trajectory for
	 * the specified number of milliseconds. This is useful for things like 'fling' gestures.
	 */
	set(value: T, options?: SpringUpdateOptions): Promise<void>;

	damping: number;
	precision: number;
	stiffness: number;
	/**
	 * The end value of the spring.
	 */
	target: T;
	/**
	 * The current value of the spring.
	 */
	get current(): T;
}

export { prefersReducedMotion, Tween } from './index.ts';
