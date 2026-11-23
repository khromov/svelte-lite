import type { ActionPayload } from '../../types.ts';
import { effect, render_effect } from '../../reactivity/effects.ts';
import { untrack } from '../../runtime.ts';

export function action<P>(
	dom: Element,
	action: (dom: Element, value?: P) => ActionPayload<P> | void,
	get_value?: () => P
): void {
	effect(() => {
		var payload = untrack(() => action(dom, get_value?.()) || {}) as ActionPayload<P>;

		if (get_value && payload.update) {
			var inited = false;
			// initialize with something so it's never equal on first run
			var prev = {} as P;

			render_effect(() => {
				// Svelte also reads everything inside the value here, so that mutating a property
				// of `$state` that was passed to the action counts as an update. That is left out:
				// `update` is called when the expression itself gives another value
				var value = get_value();

				if (inited && prev !== value) {
					prev = value;
					payload.update!(value);
				}
			});

			inited = true;
		}

		if (payload.destroy) {
			return () => payload.destroy!();
		}
	});
}
