import type {
	BlurParams,
	CrossfadeParams,
	DrawParams,
	FadeParams,
	FlyParams,
	ScaleParams,
	SlideParams,
	TransitionConfig
} from './public.ts';
import { DEV } from 'esm-env';
import * as w from '../internal/client/warnings.ts';

export type {
	BlurParams,
	CrossfadeParams,
	DrawParams,
	EasingFunction,
	FadeParams,
	FlyParams,
	ScaleParams,
	SlideParams,
	TransitionConfig
} from './public.ts';

const linear = (x: number) => x;

function cubic_out(t: number): number {
	const f = t - 1.0;
	return f * f * f + 1.0;
}

function cubic_in_out(t: number): number {
	return t < 0.5 ? 4.0 * t * t * t : 0.5 * Math.pow(2.0 * t - 2.0, 3.0) + 1.0;
}

function split_css_unit(value: number | string): [number, string] {
	const split = typeof value === 'string' && value.match(/^\s*(-?[\d.]+)([^\s]*)\s*$/);
	return split ? [parseFloat(split[1]), split[2] || 'px'] : [value as number, 'px'];
}

/** Omits unresolved dimensions rather than passing invalid values to Web Animations. */
function css_dimension(property: string, value: number, t: number): string {
	return Number.isNaN(value) ? '' : `${property}: ${t * value}px;`;
}

/** Animates a `blur` filter alongside an element's opacity. */
export function blur(
	node: Element,
	{ delay = 0, duration = 400, easing = cubic_in_out, amount = 5, opacity = 0 }: BlurParams = {}
): TransitionConfig {
	const style = getComputedStyle(node);
	const target_opacity = +style.opacity;
	const f = style.filter === 'none' ? '' : style.filter;
	const od = target_opacity * (1 - opacity);
	const [value, unit] = split_css_unit(amount);
	return {
		delay,
		duration,
		easing,
		css: (_t, u) => `opacity: ${target_opacity - od * u}; filter: ${f} blur(${u * value}${unit});`
	};
}

/**
 * Animates the opacity of an element from 0 to the current opacity for `in` transitions and from the current opacity to 0 for `out` transitions.
 */
export function fade(
	node: Element,
	{ delay = 0, duration = 400, easing = linear }: FadeParams = {}
): TransitionConfig {
	const o = +getComputedStyle(node).opacity;
	return {
		delay,
		duration,
		easing,
		css: (t) => `opacity: ${t * o}`
	};
}

/**
 * Animates the x and y positions and the opacity of an element. `in` transitions animate from the provided values, passed as parameters to the element's default values. `out` transitions animate from the element's default values to the provided values.
 */
export function fly(
	node: Element,
	{ delay = 0, duration = 400, easing = cubic_out, x = 0, y = 0, opacity = 0 }: FlyParams = {}
): TransitionConfig {
	const style = getComputedStyle(node);
	const target_opacity = +style.opacity;
	const transform = style.transform === 'none' ? '' : style.transform;
	const od = target_opacity * (1 - opacity);
	const [x_value, x_unit] = split_css_unit(x);
	const [y_value, y_unit] = split_css_unit(y);
	return {
		delay,
		duration,
		easing,
		css: (t, u) => `
			transform: ${transform} translate(${(1 - t) * x_value}${x_unit}, ${(1 - t) * y_value}${y_unit});
			opacity: ${target_opacity - od * u}`
	};
}

var slide_warning = false;

/** Slides an element in and out. */
export function slide(
	node: Element,
	{ delay = 0, duration = 400, easing = cubic_out, axis = 'y' }: SlideParams = {}
): TransitionConfig {
	const style = getComputedStyle(node);

	if (DEV && !slide_warning && /(contents|inline|table)/.test(style.display)) {
		slide_warning = true;
		Promise.resolve().then(() => (slide_warning = false));
		w.transition_slide_display(style.display);
	}

	const opacity = +style.opacity;
	const primary_property = axis === 'y' ? 'height' : 'width';
	const primary_property_value = parseFloat(style[primary_property]);
	const secondary_properties = axis === 'y' ? ['top', 'bottom'] : ['left', 'right'];
	const capitalized_secondary_properties = secondary_properties.map(
		(e) => `${e[0].toUpperCase()}${e.slice(1)}` as 'Left' | 'Right' | 'Top' | 'Bottom'
	);
	const padding_start_value = parseFloat(style[`padding${capitalized_secondary_properties[0]}`]);
	const padding_end_value = parseFloat(style[`padding${capitalized_secondary_properties[1]}`]);
	const margin_start_value = parseFloat(style[`margin${capitalized_secondary_properties[0]}`]);
	const margin_end_value = parseFloat(style[`margin${capitalized_secondary_properties[1]}`]);
	const border_width_start_value = parseFloat(
		style[`border${capitalized_secondary_properties[0]}Width`]
	);
	const border_width_end_value = parseFloat(
		style[`border${capitalized_secondary_properties[1]}Width`]
	);
	return {
		delay,
		duration,
		easing,
		css: (t) =>
			'overflow: hidden;' +
			`opacity: ${Math.min(t * 20, 1) * opacity};` +
			css_dimension(primary_property, primary_property_value, t) +
			css_dimension(`padding-${secondary_properties[0]}`, padding_start_value, t) +
			css_dimension(`padding-${secondary_properties[1]}`, padding_end_value, t) +
			css_dimension(`margin-${secondary_properties[0]}`, margin_start_value, t) +
			css_dimension(`margin-${secondary_properties[1]}`, margin_end_value, t) +
			css_dimension(`border-${secondary_properties[0]}-width`, border_width_start_value, t) +
			css_dimension(`border-${secondary_properties[1]}-width`, border_width_end_value, t) +
			`min-${primary_property}: 0`
	};
}

/**
 * Animates the opacity and scale of an element. `in` transitions animate from the provided values, passed as parameters, to an element's current (default) values. `out` transitions animate from an element's default values to the provided values.
 */
export function scale(
	node: Element,
	{ delay = 0, duration = 400, easing = cubic_out, start = 0, opacity = 0 }: ScaleParams = {}
): TransitionConfig {
	const style = getComputedStyle(node);
	const target_opacity = +style.opacity;
	const transform = style.transform === 'none' ? '' : style.transform;
	const sd = 1 - start;
	const od = target_opacity * (1 - opacity);
	return {
		delay,
		duration,
		easing,
		css: (_t, u) => `
			transform: ${transform} scale(${1 - sd * u});
			opacity: ${target_opacity - od * u}
		`
	};
}

/**
 * Animates the stroke of an SVG element, like a snake in a tube. `in` transitions begin with the path invisible and draw the path to the screen over time. `out` transitions start in a visible state and gradually erase the path. `draw` only works with elements that have a `getTotalLength` method, like `<path>` and `<polyline>`.
 */
export function draw(
	node: SVGElement & { getTotalLength(): number },
	{ delay = 0, speed, duration, easing = cubic_in_out }: DrawParams = {}
): TransitionConfig {
	let len = node.getTotalLength();
	const style = getComputedStyle(node);
	if (style.strokeLinecap !== 'butt') {
		len += parseInt(style.strokeWidth);
	}
	if (duration === undefined) {
		if (speed === undefined) {
			duration = 800;
		} else {
			duration = len / speed;
		}
	} else if (typeof duration === 'function') {
		duration = duration(len);
	}
	return {
		delay,
		duration,
		easing,
		css: (_, u) => `
			stroke-dasharray: ${len};
			stroke-dashoffset: ${u * len};
		`
	};
}

function assign<T, S>(tar: T, src: S): T & S {
	for (const k in src) (tar as any)[k] = src[k];
	return tar as T & S;
}

type CrossfadeTransition = (
	node: any,
	params: CrossfadeParams & { key: any }
) => () => TransitionConfig;

/**
 * The `crossfade` function creates a pair of [transitions](https://svelte.dev/docs/svelte/transition) called `send` and `receive`. When an element is 'sent', it looks for a corresponding element being 'received', and generates a transition that transforms the element to its counterpart's position and fades it out. When an element is 'received', the reverse happens. If there is no counterpart, the `fallback` transition is used.
 */
export function crossfade({
	fallback,
	...defaults
}: CrossfadeParams & {
	fallback?: (node: Element, params: CrossfadeParams, intro: boolean) => TransitionConfig;
}): [CrossfadeTransition, CrossfadeTransition] {
	const to_receive = new Map<any, Element>();
	const to_send = new Map<any, Element>();

	function crossfade(from_node: Element, node: Element, params: CrossfadeParams): TransitionConfig {
		const {
			delay = 0,
			duration = (d: number) => Math.sqrt(d) * 30,
			easing = cubic_out
		} = assign(assign({}, defaults), params);
		const from = from_node.getBoundingClientRect();
		const to = node.getBoundingClientRect();
		const dx = from.left - to.left;
		const dy = from.top - to.top;
		const dw = from.width / to.width;
		const dh = from.height / to.height;
		const d = Math.sqrt(dx * dx + dy * dy);
		const style = getComputedStyle(node);
		const transform = style.transform === 'none' ? '' : style.transform;
		const opacity = +style.opacity;
		return {
			delay,
			duration: typeof duration === 'function' ? duration(d) : duration,
			easing,
			css: (t, u) => `
			   opacity: ${t * opacity};
			   transform-origin: top left;
			   transform: ${transform} translate(${u * dx}px,${u * dy}px) scale(${t + (1 - t) * dw}, ${
						t + (1 - t) * dh
					});
		   `
		};
	}

	function transition(
		items: Map<any, Element>,
		counterparts: Map<any, Element>,
		intro: boolean
	): CrossfadeTransition {
		return (node, params) => {
			items.set(params.key, node);
			return () => {
				if (counterparts.has(params.key)) {
					const other_node = counterparts.get(params.key);
					counterparts.delete(params.key);
					return crossfade(other_node as Element, node, params);
				}
				// if the node is disappearing altogether
				// (i.e. wasn't claimed by the other list)
				// then we need to supply an outro
				items.delete(params.key);
				// without a `fallback` there is no config, which the public types do not say
				return (fallback && fallback(node, params, intro)) as TransitionConfig;
			};
		};
	}
	return [transition(to_send, to_receive, false), transition(to_receive, to_send, true)];
}
