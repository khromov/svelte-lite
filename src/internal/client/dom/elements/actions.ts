import type { ActionPayload } from '../../types.ts';
import { effect, render_effect } from '../../reactivity/effects.ts';
import { safe_not_equal } from '../../reactivity/equality.ts';
import { deep_read_state, untrack } from '../../runtime.ts';

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
				var value = get_value();

				// Action's update method is coarse-grained, i.e. when anything in the passed value changes, update.
				// With `$state` and mutation, it wouldn't notice the change without a deep read.
				deep_read_state(value);

				if (inited && safe_not_equal(prev, value)) {
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
