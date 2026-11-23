import type { Derived } from '../internal/client/types.ts';
import { DEV } from 'esm-env';
import { tag } from '../internal/client/dev/tracing.ts';
import { derived } from '../internal/client/index.ts';
import { set, state } from '../internal/client/reactivity/sources.ts';
import { active_reaction, get, set_active_reaction } from '../internal/client/runtime.ts';

var inited = false;

/**
 * A reactive version of the built-in [`Date`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date) object.
 * Reading the date (whether with methods like `date.getTime()` or `date.toString()`, or via things like [`Intl.DateTimeFormat`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat))
 * in an [effect](https://svelte.dev/docs/svelte/$effect) or [derived](https://svelte.dev/docs/svelte/$derived)
 * will cause it to be re-evaluated when the value of the date changes.
 *
 * ```svelte
 * <script>
 * 	import { SvelteDate } from 'svelte/reactivity';
 *
 * 	const date = new SvelteDate();
 *
 * 	const formatter = new Intl.DateTimeFormat(undefined, {
 * 	  hour: 'numeric',
 * 	  minute: 'numeric',
 * 	  second: 'numeric'
 * 	});
 *
 * 	$effect(() => {
 * 		const interval = setInterval(() => {
 * 			date.setTime(Date.now());
 * 		}, 1000);
 *
 * 		return () => {
 * 			clearInterval(interval);
 * 		};
 * 	});
 * </script>
 *
 * <p>The time is {formatter.format(date)}</p>
 * ```
 */
export class SvelteDate extends Date {
	#time = state(super.getTime());

	#deriveds = new Map<keyof Date, Derived<unknown>>();

	#reaction = active_reaction;

	constructor(...params: any[]) {
		// `Date` takes anything from no arguments to seven
		super(...(params as []));

		if (DEV) {
			tag(this.#time, 'SvelteDate.#time');
		}

		if (!inited) this.#init();
	}

	// We init as part of the first instance so that we can treeshake this class
	#init() {
		inited = true;

		var proto = SvelteDate.prototype as any;
		var date_proto = Date.prototype as any;

		var methods = Object.getOwnPropertyNames(date_proto) as Array<keyof Date & string>;

		for (const method of methods) {
			if (method.startsWith('get') || method.startsWith('to') || method === 'valueOf') {
				proto[method] = function (this: SvelteDate, ...args: any[]) {
					// don't memoize if there are arguments
					if (args.length > 0) {
						get(this.#time);
						return date_proto[method].apply(this, args);
					}

					var d = this.#deriveds.get(method);

					if (d === undefined) {
						// lazily create the derived, but as though it were being
						// created at the same time as the class instance
						const reaction = active_reaction;
						set_active_reaction(this.#reaction);

						d = derived(() => {
							get(this.#time);
							return date_proto[method].apply(this, args);
						});

						if (DEV) {
							tag(d, `SvelteDate.${method}()`);
						}

						this.#deriveds.set(method, d);

						set_active_reaction(reaction);
					}

					return get(d);
				};
			}

			if (method.startsWith('set')) {
				proto[method] = function (this: SvelteDate, ...args: any[]) {
					var result = date_proto[method].apply(this, args);
					set(this.#time, date_proto.getTime.call(this));
					return result;
				};
			}
		}
	}
}
