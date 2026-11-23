import { dev_current_component_function } from './context.ts';
import { FILENAME } from '../../constants.ts';
import { render_effect } from './reactivity/effects.ts';
import * as w from './warnings.ts';
import { capture_store_binding } from './reactivity/store.ts';

/**
 * `blockers` only has content with `experimental.async`, which svelte-lite leaves out. It is in
 * the signature because the compiler passes the arguments after it by position.
 */
export function validate_binding(
	binding: string,
	blockers: unknown[],
	get_object: () => Record<string, any>,
	get_property: () => string,
	line: number,
	column: number
): void {
	var warned = false;

	var filename = dev_current_component_function?.[FILENAME];

	render_effect(() => {
		if (warned) return;

		var [object, is_store_sub] = capture_store_binding(get_object);

		if (is_store_sub) return;

		var property = get_property();

		var ran = false;

		// by making the (possibly false, but it would be an extreme edge case) assumption
		// that a getter has a corresponding setter, we can determine if a property is
		// reactive by seeing if this effect has dependencies
		var effect = render_effect(() => {
			if (ran) return;

			// eslint-disable-next-line @typescript-eslint/no-unused-expressions
			object[property];
		});

		ran = true;

		if (effect.edges === null) {
			var location = `${filename}:${line}:${column}`;
			w.binding_property_non_reactive(binding, location);

			warned = true;
		}
	});
}
