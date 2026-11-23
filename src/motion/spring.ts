import type { Source, Task } from '../internal/client/types.ts';
import type { TickContext } from './private.ts';
import type { Spring as SpringStore, SpringOptions, SpringUpdateOptions } from './public.ts';
import { writable } from '../store/shared/index.ts';
import { loop } from '../internal/client/loop.ts';
import { raf } from '../internal/client/timing.ts';
import { is_date } from './utils.ts';
import { set, state } from '../internal/client/reactivity/sources.ts';
import { render_effect } from '../internal/client/reactivity/effects.ts';
import { tag } from '../internal/client/dev/tracing.ts';
import { get } from '../internal/client/runtime.ts';
import { deferred, noop } from '../internal/shared/utils.ts';
import { DEV } from 'esm-env';

function tick_spring<T>(ctx: TickContext, last_value: T, current_value: T, target_value: T): T;
function tick_spring(ctx: TickContext, last_value: any, current_value: any, target_value: any): any {
	if (typeof current_value === 'number' || is_date(current_value)) {
		// a date takes part in the arithmetic as its timestamp
		const delta = target_value - (current_value as any);
		const velocity = ((current_value as any) - last_value) / (ctx.dt || 1 / 60); // guard div by 0
		const spring = ctx.opts.stiffness * delta;
		const damper = ctx.opts.damping * velocity;
		const acceleration = (spring - damper) * ctx.inv_mass;
		const d = (velocity + acceleration) * ctx.dt;
		if (Math.abs(d) < ctx.opts.precision && Math.abs(delta) < ctx.opts.precision) {
			return target_value; // settled
		} else {
			ctx.settled = false; // signal loop to keep ticking
			return is_date(current_value) ? new Date(current_value.getTime() + d) : current_value + d;
		}
	} else if (Array.isArray(current_value)) {
		return current_value.map((_, i) =>
			tick_spring(ctx, last_value[i], current_value[i], target_value[i])
		);
	} else if (typeof current_value === 'object') {
		const next_value: Record<string, any> = {};
		for (const k in current_value) {
			next_value[k] = tick_spring(ctx, last_value[k], current_value[k], target_value[k]);
		}
		return next_value;
	} else {
		throw new Error(`Cannot spring ${typeof current_value} values`);
	}
}

/**
 * The spring function in Svelte creates a store whose value is animated, with a motion that simulates the behavior of a spring. This means when the value changes, instead of transitioning at a steady rate, it "bounces" like a spring would, depending on the physics parameters provided. This adds a level of realism to the transitions and can enhance the user experience.
 *
 * @deprecated Use [`Spring`](https://svelte.dev/docs/svelte/svelte-motion#Spring) instead
 */
export function spring<T = any>(value?: T, opts: SpringOptions = {}): SpringStore<T> {
	const store = writable(value);
	const { stiffness = 0.15, damping = 0.8, precision = 0.01 } = opts;
	let last_time: number;
	let task: Task | null;
	let current_token: object;

	let last_value = value as T;
	let target_value = value;

	let inv_mass = 1;
	let inv_mass_recovery_rate = 0;
	let cancel_task = false;

	function set(new_value: T, opts: SpringUpdateOptions = {}): Promise<void> {
		target_value = new_value;
		const token = (current_token = {});
		if (value == null || opts.hard || (spring.stiffness >= 1 && spring.damping >= 1)) {
			cancel_task = true; // cancel any running animation
			last_time = raf.now();
			last_value = new_value;
			store.set((value = target_value));
			return Promise.resolve();
		} else if (opts.soft) {
			const rate = opts.soft === true ? 0.5 : +opts.soft;
			inv_mass_recovery_rate = 1 / (rate * 60);
			inv_mass = 0; // infinite mass, unaffected by spring forces
		}
		if (!task) {
			last_time = raf.now();
			cancel_task = false;
			task = loop((now) => {
				if (cancel_task) {
					cancel_task = false;
					task = null;
					return false;
				}
				inv_mass = Math.min(inv_mass + inv_mass_recovery_rate, 1);

				// clamp elapsed time to 1/30th of a second, so that longer pauses
				// (blocked thread or inactive tab) don't cause the spring to go haywire
				const elapsed = Math.min(now - last_time, 1000 / 30);

				const ctx: TickContext = {
					inv_mass,
					opts: spring,
					settled: true,
					dt: (elapsed * 60) / 1000
				};
				const next_value = tick_spring(ctx, last_value, value as T, target_value as T);
				last_time = now;
				last_value = value as T;
				store.set((value = next_value));
				if (ctx.settled) {
					task = null;
				}
				return !ctx.settled;
			});
		}
		return new Promise((fulfil) => {
			(task as Task).promise.then(() => {
				if (token === current_token) fulfil();
			});
		});
	}

	// @ts-expect-error - class-only properties are missing
	const spring: SpringStore<T> = {
		set,
		update: (fn, opts) => set(fn(target_value as T, value as T), opts),
		subscribe: store.subscribe,
		stiffness,
		damping,
		precision
	};
	return spring;
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
export class Spring<T> {
	#stiffness = state(0.15);
	#damping = state(0.8);
	#precision = state(0.01);

	#current: Source<T>;
	#target: Source<T>;

	#last_value = undefined as T;
	#last_time = 0;

	#inverse_mass = 1;
	#momentum = 0;

	#task: Task | null = null;

	#deferred: ReturnType<typeof deferred<void>> | null = null;

	constructor(value: T, options: SpringOptions = {}) {
		this.#current = DEV ? tag(state(value), 'Spring.current') : state(value);
		this.#target = DEV ? tag(state(value), 'Spring.target') : state(value);

		if (typeof options.stiffness === 'number') this.#stiffness.v = clamp(options.stiffness, 0, 1);
		if (typeof options.damping === 'number') this.#damping.v = clamp(options.damping, 0, 1);
		if (typeof options.precision === 'number') this.#precision.v = options.precision;

		if (DEV) {
			tag(this.#stiffness, 'Spring.stiffness');
			tag(this.#damping, 'Spring.damping');
			tag(this.#precision, 'Spring.precision');
			tag(this.#current, 'Spring.current');
			tag(this.#target, 'Spring.target');
		}
	}

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
	static of<U>(fn: () => U, options?: SpringOptions): Spring<U> {
		const spring = new Spring(fn(), options);

		render_effect(() => {
			spring.set(fn());
		});

		return spring;
	}

	#update(value: T): Promise<void> {
		set(this.#target, value);

		this.#current.v ??= value;
		this.#last_value ??= this.#current.v;

		if (!this.#task) {
			this.#last_time = raf.now();

			var inv_mass_recovery_rate = 1000 / (this.#momentum * 60);

			this.#task ??= loop((now) => {
				this.#inverse_mass = Math.min(this.#inverse_mass + inv_mass_recovery_rate, 1);

				// clamp elapsed time to 1/30th of a second, so that longer pauses
				// (blocked thread or inactive tab) don't cause the spring to go haywire
				const elapsed = Math.min(now - this.#last_time, 1000 / 30);

				const ctx: TickContext = {
					inv_mass: this.#inverse_mass,
					opts: {
						stiffness: this.#stiffness.v,
						damping: this.#damping.v,
						precision: this.#precision.v
					},
					settled: true,
					dt: (elapsed * 60) / 1000
				};

				var next = tick_spring(ctx, this.#last_value, this.#current.v, this.#target.v);
				this.#last_value = this.#current.v;
				this.#last_time = now;
				set(this.#current, next);

				if (ctx.settled) {
					this.#task = null;
				}

				return !ctx.settled;
			});
		}

		return this.#task.promise;
	}

	/**
	 * Sets `spring.target` to `value` and returns a `Promise` that resolves if and when `spring.current` catches up to it.
	 *
	 * If `options.instant` is `true`, `spring.current` immediately matches `spring.target`.
	 *
	 * If `options.preserveMomentum` is provided, the spring will continue on its current trajectory for
	 * the specified number of milliseconds. This is useful for things like 'fling' gestures.
	 */
	set(value: T, options?: SpringUpdateOptions): Promise<void> {
		this.#deferred?.reject(new Error('Aborted'));

		if (options?.instant || this.#current.v === undefined) {
			this.#task?.abort();
			this.#task = null;
			set(this.#current, set(this.#target, value));
			this.#last_value = value;
			return Promise.resolve();
		}

		if (options?.preserveMomentum) {
			this.#inverse_mass = 0;
			this.#momentum = options.preserveMomentum;
		}

		var d = (this.#deferred = deferred());
		d.promise.catch(noop);

		this.#update(value).then(() => {
			if (d !== this.#deferred) return;
			d.resolve(undefined);
		});

		return d.promise;
	}

	get current(): T {
		return get(this.#current);
	}

	get damping(): number {
		return get(this.#damping);
	}

	set damping(v: number) {
		set(this.#damping, clamp(v, 0, 1));
	}

	get precision(): number {
		return get(this.#precision);
	}

	set precision(v: number) {
		set(this.#precision, v);
	}

	get stiffness(): number {
		return get(this.#stiffness);
	}

	set stiffness(v: number) {
		set(this.#stiffness, clamp(v, 0, 1));
	}

	get target(): T {
		return get(this.#target);
	}

	set target(v: T) {
		this.set(v);
	}
}

function clamp(n: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, n));
}
