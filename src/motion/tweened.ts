import type { Source, Task } from '../internal/client/types.ts';
import type { Tweened, TweenOptions } from './public.ts';
import { writable } from '../store/shared/index.ts';
import { raf } from '../internal/client/timing.ts';
import { loop } from '../internal/client/loop.ts';
import { linear } from '../easing/index.ts';
import { is_date } from './utils.ts';
import { set, state } from '../internal/client/reactivity/sources.ts';
import { render_effect } from '../internal/client/reactivity/effects.ts';
import { tag } from '../internal/client/dev/tracing.ts';
import { get } from '../internal/client/runtime.ts';
import { DEV } from 'esm-env';

function get_interpolator<T>(a: T, b: T): (t: number) => T;
function get_interpolator(a: any, b: any): (t: number) => any {
	if (a === b || a !== a) return () => a;

	const type = typeof a;
	if (type !== typeof b || Array.isArray(a) !== Array.isArray(b)) {
		throw new Error('Cannot interpolate values of different type');
	}

	if (Array.isArray(a)) {
		const arr = (b as any[]).map((bi, i) => {
			return get_interpolator(a[i], bi);
		});

		return (t) => arr.map((fn) => fn(t));
	}

	if (type === 'object') {
		if (!a || !b) {
			throw new Error('Object cannot be null');
		}

		if (is_date(a) && is_date(b)) {
			const an = a.getTime();
			const bn = b.getTime();
			const delta = bn - an;

			return (t) => new Date(an + t * delta);
		}

		const keys = Object.keys(b);

		const interpolators: Record<string, (t: number) => any> = {};
		keys.forEach((key) => {
			interpolators[key] = get_interpolator(a[key], b[key]);
		});

		return (t) => {
			const result: Record<string, any> = {};
			keys.forEach((key) => {
				result[key] = interpolators[key](t);
			});
			return result;
		};
	}

	if (type === 'number') {
		const delta = b - a;
		return (t) => a + t * delta;
	}

	// for non-numeric values, snap to the final value immediately
	return () => b;
}

/**
 * A tweened store in Svelte is a special type of store that provides smooth transitions between state values over time.
 *
 * @deprecated Use [`Tween`](https://svelte.dev/docs/svelte/svelte-motion#Tween) instead
 */
export function tweened<T>(value?: T, defaults: TweenOptions<T> = {}): Tweened<T> {
	const store = writable(value);
	let task: Task;
	let target_value = value;

	function set(new_value: T, opts?: TweenOptions<T>): Promise<void> {
		target_value = new_value;

		if (value == null) {
			store.set((value = new_value));
			return Promise.resolve();
		}

		let previous_task: Task | null = task;

		let started = false;
		let {
			delay = 0,
			duration = 400,
			easing = linear,
			interpolate = get_interpolator
		} = { ...defaults, ...opts };

		if (duration === 0) {
			if (previous_task) {
				previous_task.abort();
				previous_task = null;
			}
			store.set((value = target_value));
			return Promise.resolve();
		}

		const start = raf.now() + delay;

		let fn: (t: number) => T;
		task = loop((now) => {
			if (now < start) return true;
			if (!started) {
				fn = interpolate(value as T, new_value);
				if (typeof duration === 'function') duration = duration(value as T, new_value);
				started = true;
			}
			if (previous_task) {
				previous_task.abort();
				previous_task = null;
			}
			const elapsed = now - start;
			if (elapsed > (duration as number)) {
				store.set((value = new_value));
				return false;
			}
			store.set((value = fn(easing(elapsed / (duration as number)))));
			return true;
		});
		return task.promise;
	}

	return {
		set,
		update: (fn, opts) => set(fn(target_value as T, value as T), opts),
		subscribe: store.subscribe
	};
}

/**
 * A wrapper for a value that tweens smoothly to its target value. Changes to `tween.target` will cause `tween.current` to
 * move towards it over time, taking account of the `delay`, `duration` and `easing` options.
 *
 * ```svelte
 * <script>
 * 	import { Tween } from 'svelte/motion';
 *
 * 	const tween = new Tween(0);
 * </script>
 *
 * <input type="range" bind:value={tween.target} />
 * <input type="range" value={tween.current} disabled />
 * ```
 * @since 5.8.0
 */
export class Tween<T> {
	#current: Source<T>;
	#target: Source<T>;

	#defaults: TweenOptions<T>;

	#task: Task | null = null;

	constructor(value: T, options: TweenOptions<T> = {}) {
		this.#current = state(value);
		this.#target = state(value);
		this.#defaults = options;

		if (DEV) {
			tag(this.#current, 'Tween.current');
			tag(this.#target, 'Tween.target');
		}
	}

	/**
	 * Create a tween whose value is bound to the return value of `fn`. This must be called
	 * inside an effect root (for example, during component initialisation).
	 *
	 * ```svelte
	 * <script>
	 * 	import { Tween } from 'svelte/motion';
	 *
	 * 	let { number } = $props();
	 *
	 * 	const tween = Tween.of(() => number);
	 * </script>
	 * ```
	 */
	static of<U>(fn: () => U, options?: TweenOptions<U>): Tween<U> {
		const tween = new Tween(fn(), options);

		render_effect(() => {
			tween.set(fn());
		});

		return tween;
	}

	/**
	 * Sets `tween.target` to `value` and returns a `Promise` that resolves if and when `tween.current` catches up to it.
	 *
	 * If `options` are provided, they will override the tween's defaults.
	 */
	set(value: T, options?: TweenOptions<T>): Promise<void> {
		set(this.#target, value);

		let {
			delay = 0,
			duration = 400,
			easing = linear,
			interpolate = get_interpolator
		} = { ...this.#defaults, ...options };

		if (duration === 0) {
			this.#task?.abort();
			set(this.#current, value);
			return Promise.resolve();
		}

		const start = raf.now() + delay;

		let fn: (t: number) => T;
		let started = false;
		let previous_task = this.#task;

		this.#task = loop((now) => {
			if (now < start) {
				return true;
			}

			if (!started) {
				started = true;

				const prev = this.#current.v;

				fn = interpolate(prev, value);

				if (typeof duration === 'function') {
					duration = duration(prev, value);
				}

				previous_task?.abort();
				previous_task = null;
			}

			const elapsed = now - start;

			if (elapsed > (duration as number)) {
				set(this.#current, value);
				return false;
			}

			set(this.#current, fn(easing(elapsed / (duration as number))));
			return true;
		});

		return this.#task.promise;
	}

	get current(): T {
		return get(this.#current);
	}

	get target(): T {
		return get(this.#target);
	}

	set target(v: T) {
		this.set(v);
	}
}
