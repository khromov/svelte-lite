import { DEV } from 'esm-env';
import { component_context, dev_stack } from '../../context.ts';
import { hydrate_next, hydrating } from '../hydration.ts';
import { create_element, create_text } from '../operations.ts';
import { append } from '../template.ts';

/**
 * @param location the filename, line and column of the slot
 */
export function slot(
	anchor: Comment,
	$$props: Record<string, any>,
	name: string,
	slot_props: Record<string, unknown>,
	fallback_fn: null | ((anchor: Comment) => void),
	location?: [string, number, number]
) {
	if (hydrating) {
		hydrate_next();
	}

	// Custom element slots are native DOM slots.
	// Use the stored reference because the shadow root may be closed.
	if ($$props.$$host?.$$shadowRoot) {
		const element = create_element('slot');
		if (name !== 'default') element.setAttribute('name', name);

		if (DEV && location) {
			// Native slots are created outside the template, so mark their ownership
			// before the surrounding template assigns its locations.
			// @ts-expect-error
			element.__svelte_meta = {
				parent: dev_stack,
				loc: {
					file: location[0],
					line: location[1],
					column: location[2]
				},
				component: component_context
			};
		}

		append(anchor, element);

		if (fallback_fn !== null) {
			const fallback_anchor = create_text();
			element.appendChild(fallback_anchor);
			fallback_fn(fallback_anchor);
		}

		return;
	}

	var slot_fn = $$props.$$slots?.[name];
	// Interop: Can use snippets to fill slots
	var is_interop = false;
	if (slot_fn === true) {
		slot_fn = $$props[name === 'default' ? 'children' : name];
		is_interop = true;
	}

	if (slot_fn === undefined) {
		if (fallback_fn !== null) {
			fallback_fn(anchor);
		}
	} else {
		slot_fn(anchor, is_interop ? () => slot_props : slot_props);
	}
}

export function sanitize_slots(props: Record<string, any>): Record<string, boolean> {
	const sanitized: Record<string, boolean> = {};
	if (props.children) sanitized.default = true;
	for (const key in props.$$slots) {
		sanitized[key] = true;
	}
	return sanitized;
}
