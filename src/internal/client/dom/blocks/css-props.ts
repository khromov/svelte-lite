import { render_effect } from '../../reactivity/effects.ts';
import { hydrating, set_hydrate_node } from '../hydration.ts';
import { get_first_child } from '../operations.ts';

export function css_props(
	element: HTMLDivElement | SVGGElement,
	get_styles: () => Record<string, string>
): void {
	if (hydrating) {
		set_hydrate_node(get_first_child(element));
	}

	render_effect(() => {
		var styles = get_styles();

		for (var key in styles) {
			var value = styles[key];

			if (value == null || value === '') {
				element.style.removeProperty(key);
			} else {
				element.style.setProperty(key, value);
			}
		}
	});
}
