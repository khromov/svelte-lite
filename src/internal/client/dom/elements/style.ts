import { to_style } from '../../../shared/attributes.ts';
import { STYLE_CACHE } from '../../constants.ts';
import { hydrating } from '../hydration.ts';

type Styles = Record<string, any>;

/** `style:` directives, as `[normal, important]` if any of them is `|important` */
type StyleDirectives = Styles | [Styles, Styles];

function update_styles(
	dom: Element & ElementCSSInlineStyle,
	prev: Styles = {},
	next: Styles,
	priority?: string
) {
	for (var key in next) {
		var value = next[key];

		if (prev[key] !== value) {
			if (next[key] == null) {
				dom.style.removeProperty(key);
			} else {
				dom.style.setProperty(key, value, priority);
			}
		}
	}
}

export function set_style(
	dom: Element & ElementCSSInlineStyle,
	value: string | null,
	prev_styles?: StyleDirectives,
	next_styles?: StyleDirectives
): StyleDirectives | undefined {
	var prev = (dom as any)[STYLE_CACHE];

	if (hydrating || prev !== value) {
		var next_style_attr = to_style(value, next_styles);

		if (!hydrating || next_style_attr !== dom.getAttribute('style')) {
			if (next_style_attr == null) {
				dom.removeAttribute('style');
			} else {
				dom.style.cssText = next_style_attr;
			}
		}

		(dom as any)[STYLE_CACHE] = value;
	} else if (next_styles) {
		if (Array.isArray(next_styles)) {
			update_styles(dom, prev_styles?.[0], next_styles[0]);
			update_styles(dom, prev_styles?.[1], next_styles[1], 'important');
		} else {
			update_styles(dom, prev_styles, next_styles);
		}
	}

	return next_styles;
}
