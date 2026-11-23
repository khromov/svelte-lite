import { to_class } from '../../../shared/attributes.ts';
import { CLASS_CACHE } from '../../constants.ts';
import { hydrating } from '../hydration.ts';

export function set_class(
	dom: Element,
	is_html: boolean | number,
	value: string | null,
	hash?: string,
	prev_classes?: Record<string, any>,
	next_classes?: Record<string, any>
): Record<string, boolean> | undefined {
	var prev = (dom as any)[CLASS_CACHE];

	if (
		hydrating ||
		prev !== value ||
		prev === undefined // for edge case of `class={undefined}`
	) {
		var next_class_name = to_class(value, hash, next_classes);

		if (!hydrating || next_class_name !== dom.getAttribute('class')) {
			// Removing the attribute when the value is only an empty string causes
			// performance issues vs simply making the className an empty string. So
			// we should only remove the class if the value is nullish
			// and there no hash/directives :
			if (next_class_name == null) {
				dom.removeAttribute('class');
			} else if (is_html) {
				dom.className = next_class_name;
			} else {
				dom.setAttribute('class', next_class_name);
			}
		}

		(dom as any)[CLASS_CACHE] = value;
	} else if (next_classes && prev_classes !== next_classes) {
		for (var key in next_classes) {
			var is_present = !!next_classes[key];

			if (prev_classes == null || is_present !== !!prev_classes[key]) {
				dom.classList.toggle(key, is_present);
			}
		}
	}

	return next_classes;
}
