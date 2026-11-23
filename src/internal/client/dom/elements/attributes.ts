import { DEV } from 'esm-env';
import type { Effect } from '../../types.ts';
import { ATTACHMENT_KEY, NAMESPACE_HTML, UNINITIALIZED } from '../../../../constants.ts';
import { can_delegate_event, is_capture_event, normalize_attribute } from '../../../../utils.ts';
import { clsx } from '../../../shared/attributes.ts';
import { get_descriptors, get_prototype_of } from '../../../shared/utils.ts';
import {
	ATTRIBUTES_CACHE,
	FORM_RESET_HANDLER,
	IS_XHTML,
	LOADING_ATTR_SYMBOL
} from '../../constants.ts';
import { flatten } from '../../reactivity/async.ts';
import { branch, destroy_effect, effect, managed } from '../../reactivity/effects.ts';
import {
	active_effect,
	active_reaction,
	get,
	set_active_effect,
	set_active_reaction
} from '../../runtime.ts';
import * as w from '../../warnings.ts';
import { hydrating, set_hydrating } from '../hydration.ts';
import { set_attribute as set_attribute_op } from '../operations.ts';
import { queue_micro_task } from '../task.ts';
import { attach } from './attachments.ts';
import {
	init_select,
	select_option,
	set_default_select_value,
	set_selected
} from './bindings/select.ts';
import { set_class } from './class.ts';
import { create_event, delegate, delegated } from './events.ts';
import { add_form_reset_listener, autofocus } from './misc.ts';
import { set_style } from './style.ts';

/** What a spread is given: attributes by name, plus `CLASS`, `STYLE` and attachments by symbol */
type Attributes = Record<string | symbol, any>;

export const CLASS = Symbol('class');
export const STYLE = Symbol('style');

const IS_CUSTOM_ELEMENT = Symbol('is custom element');
const IS_HTML = Symbol('is html');

const LINK_TAG = IS_XHTML ? 'link' : 'LINK';
const INPUT_TAG = IS_XHTML ? 'input' : 'INPUT';
const OPTION_TAG = IS_XHTML ? 'option' : 'OPTION';
const SELECT_TAG = IS_XHTML ? 'select' : 'SELECT';
const PROGRESS_TAG = IS_XHTML ? 'progress' : 'PROGRESS';

/**
 * The value/checked attribute in the template actually corresponds to the defaultValue property, so we need
 * to remove it upon hydration to avoid a bug when someone resets the form value.
 */
export function remove_input_defaults(input: HTMLInputElement): void {
	if (!hydrating) return;

	var already_removed = false;

	// We try and remove the default attributes later, rather than sync during hydration.
	// Doing it sync during hydration has a negative impact on performance, but deferring the
	// work in an idle task alleviates this greatly. If a form reset event comes in before
	// the idle callback, then we ensure the input defaults are cleared just before.
	var remove_defaults = () => {
		if (already_removed) return;
		already_removed = true;

		// Remove the attributes but preserve the values
		if (input.hasAttribute('value')) {
			var value = input.value;
			set_attribute(input, 'value', null);
			input.value = value;
		}

		if (input.hasAttribute('checked')) {
			var checked = input.checked;
			set_attribute(input, 'checked', null);
			input.checked = checked;
		}
	};

	(input as any)[FORM_RESET_HANDLER] = remove_defaults;
	queue_micro_task(remove_defaults);
	add_form_reset_listener();
}

export function set_value(element: Element, value: any): void {
	var attributes = get_attributes(element);

	if (
		attributes.value ===
			(attributes.value =
				// treat null and undefined the same for the initial value
				value ?? undefined) ||
		// `progress` elements always need their value set when it's `0`
		((element as any).value === value && (value !== 0 || element.nodeName !== PROGRESS_TAG))
	) {
		return;
	}

	(element as any).value = value ?? '';
}

export function set_checked(element: Element, checked: boolean): void {
	var attributes = get_attributes(element);

	if (
		attributes.checked ===
		(attributes.checked =
			// treat null and undefined the same for the initial value
			checked ?? undefined)
	) {
		return;
	}

	(element as any).checked = checked;
}

/**
 * Applies the default checked property without influencing the current checked property.
 */
export function set_default_checked(element: HTMLInputElement, checked: boolean): void {
	const existing_value = element.checked;
	element.defaultChecked = checked;
	element.checked = existing_value;
}

/**
 * Applies the default value property without influencing the current value property.
 */
export function set_default_value(
	element: HTMLInputElement | HTMLTextAreaElement,
	value: string
): void {
	const existing_value = element.value;
	element.defaultValue = value;
	element.value = existing_value;
}

export function set_attribute(
	element: Element,
	attribute: string,
	value: any,
	skip_warning?: boolean
): void {
	var attributes = get_attributes(element);

	if (hydrating) {
		attributes[attribute] = element.getAttribute(attribute);

		if (
			attribute === 'src' ||
			attribute === 'srcset' ||
			(attribute === 'href' && element.nodeName === LINK_TAG)
		) {
			if (!skip_warning) {
				check_src_in_dev_hydration(element, attribute, value ?? '');
			}

			// If we reset these attributes, they would result in another network request, which we want to avoid.
			// We assume they are the same between client and server as checking if they are equal is expensive
			// (we can't just compare the strings as they can be different between client and server but result in the
			// same url, so we would need to create hidden anchor elements to compare them)
			return;
		}
	}

	var previous = attributes[attribute];
	if (previous === (attributes[attribute] = value)) return;

	if (attribute === 'loading') {
		(element as any)[LOADING_ATTR_SYMBOL] = value;
	}

	if (value == null) {
		element.removeAttribute(attribute);
	} else if (typeof value !== 'string' && get_setters(element).has(attribute)) {
		(element as any)[attribute] = value;
	} else if (
		// while hydrating, skip a number or boolean whose string the server already rendered
		!(
			hydrating &&
			(typeof value === 'number' || typeof value === 'boolean') &&
			previous === String(value)
		)
	) {
		set_attribute_op(element, attribute, value);
	}
}

export function set_xlink_attribute(dom: Element, attribute: string, value: string): void {
	dom.setAttributeNS('http://www.w3.org/1999/xlink', attribute, value);
}

export function set_custom_element_data(node: HTMLElement, prop: string, value: any): void {
	// We need to ensure that setting custom element props, which can
	// invoke lifecycle methods on other custom elements, does not also
	// associate those lifecycle methods with the current active reaction
	// or effect
	var previous_reaction = active_reaction;
	var previous_effect = active_effect;

	// If we're hydrating but the custom element is from Svelte, and it already scaffolded,
	// then it might run block logic in hydration mode, which we have to prevent.
	let was_hydrating = hydrating;
	if (hydrating) {
		set_hydrating(false);
	}

	set_active_reaction(null);
	set_active_effect(null);

	try {
		if (
			// `style` should use `set_attribute` rather than the setter
			prop !== 'style' &&
			// Don't compute setters for custom elements while they aren't registered yet,
			// because during their upgrade/instantiation they might add more setters.
			// Instead, fall back to a simple "an object, then set as property" heuristic.
			(setters_cache.has(node.getAttribute('is') || node.nodeName) ||
			// customElements may not be available in browser extension contexts
			!customElements ||
			customElements.get(node.getAttribute('is') || node.nodeName.toLowerCase())
				? get_setters(node).has(prop)
				: value && typeof value === 'object')
		) {
			(node as any)[prop] = value;
		} else {
			// We did getters etc checks already, stringify before passing to set_attribute
			// to ensure it doesn't invoke the same logic again, and potentially populating
			// the setters cache too early.
			set_attribute(node, prop, value == null ? value : String(value));
		}
	} finally {
		set_active_reaction(previous_reaction);
		set_active_effect(previous_effect);
		if (was_hydrating) {
			set_hydrating(true);
		}
	}
}

/**
 * Spreads attributes onto a DOM element, taking into account the currently set attributes
 * @param next New attributes - this function mutates this object
 */
function set_attributes(
	element: Element & ElementCSSInlineStyle,
	prev: Attributes | undefined,
	next: Attributes,
	css_hash?: string,
	should_remove_defaults = false,
	skip_warning = false
): Attributes {
	if (hydrating && should_remove_defaults && element.nodeName === INPUT_TAG) {
		if (!('defaultValue' in next || 'defaultChecked' in next)) {
			remove_input_defaults(element as HTMLInputElement);
		}
	}

	var attributes = get_attributes(element);

	var is_custom_element = attributes[IS_CUSTOM_ELEMENT];
	var preserve_attribute_case = !attributes[IS_HTML];

	// If we're hydrating but the custom element is from Svelte, and it already scaffolded,
	// then it might run block logic in hydration mode, which we have to prevent.
	let is_hydrating_custom_element = hydrating && is_custom_element;
	if (is_hydrating_custom_element) {
		set_hydrating(false);
	}

	var current = prev || {};
	var is_option_element = element.nodeName === OPTION_TAG;
	var is_select_element = element.nodeName === SELECT_TAG;

	// the properties that only some elements have, and the internal `__value`
	var node = element as any;

	try {
		for (var key in prev) {
			// don't null our internal $$onX listeners
			if (!(key in next) && key[0] + key[1] !== '$$') {
				next[key] = null;
			}
		}

		if (next.class) {
			next.class = clsx(next.class);
		} else if (css_hash || next[CLASS]) {
			next.class = null; /* force call to set_class() */
		}

		if (next[STYLE]) {
			next.style ??= null; /* force call to set_style() */
		}

		var setters = get_setters(element);

		if (element.nodeName === INPUT_TAG && 'type' in next && ('value' in next || '__value' in next)) {
			var type = next.type;

			if (type !== current.type || (type === undefined && element.hasAttribute('type'))) {
				current.type = type;
				set_attribute(element, 'type', type, skip_warning);
			}
		}

		// since key is captured we use const
		for (const key in next) {
			// let instead of var because referenced in a closure
			let value = next[key];

			// Up here because we want to do this for the initial value, too, even if it's undefined,
			// and this wouldn't be reached in case of undefined because of the equality check below
			if (is_option_element && key === 'value' && value == null) {
				// The <option> element is a special case because removing the value attribute means
				// the value is set to the text content of the option element, and setting the value
				// to null or undefined means the value is set to the string "null" or "undefined".
				// To align with how we handle this case in non-spread-scenarios, this logic is needed.
				// There's a super-edge-case bug here that is left in favor of smaller code size:
				// Because of the "set missing props to null" logic above, we can't differentiate
				// between a missing value and an explicitly set value of null or undefined. That means
				// that once set, the value attribute of an <option> element can't be removed. This is
				// a very rare edge case, and removing the attribute altogether isn't possible either
				// for the <option value={undefined}> case, so we're not losing any functionality here.
				node.value = node.__value = '';
				current[key] = value;
				continue;
			}

			if (key === 'class') {
				var is_html = element.namespaceURI === NAMESPACE_HTML;
				set_class(element, is_html, value, css_hash, prev?.[CLASS], next[CLASS]);
				current[key] = value;
				current[CLASS] = next[CLASS];
				continue;
			}

			if (key === 'style') {
				set_style(element, value, prev?.[STYLE], next[STYLE]);
				current[key] = value;
				current[STYLE] = next[STYLE];
				continue;
			}

			var prev_value = current[key];

			// Skip if value is unchanged, unless it's `undefined` and the element still has the attribute
			if (value === prev_value && !(value === undefined && element.hasAttribute(key))) {
				continue;
			}

			current[key] = value;

			var prefix = key[0] + key[1]; // this is faster than key.slice(0, 2)
			if (prefix === '$$') continue;

			if (prefix === 'on') {
				const opts: { capture?: true } = {};
				const event_handle_key = '$$' + key;
				let event_name = key.slice(2);
				var is_delegated = can_delegate_event(event_name);

				if (is_capture_event(event_name)) {
					event_name = event_name.slice(0, -7);
					opts.capture = true;
				}

				if (!is_delegated && prev_value) {
					// Listening to same event but different handler -> our handle function below takes care of this
					// If we were to remove and add listeners in this case, it could happen that the event is "swallowed"
					// (the browser seems to not know yet that a new one exists now) and doesn't reach the handler
					// https://github.com/sveltejs/svelte/issues/11903
					if (value != null) continue;

					element.removeEventListener(event_name, current[event_handle_key], opts);
					current[event_handle_key] = null;
				}

				if (is_delegated) {
					delegated(event_name, element, value);
					delegate([event_name]);
				} else if (value != null) {
					function handle(this: any, ...args: any[]) {
						current[key].apply(this, args);
					}

					current[event_handle_key] = create_event(event_name, element, handle, opts);
				}
			} else if (key === 'autofocus') {
				autofocus(node, Boolean(value));
			} else if (!is_custom_element && (key === '__value' || (key === 'value' && value != null))) {
				// We're not running this for custom elements because __value is actually
				// how Lit stores the current value on the element, and messing with that would break things.
				node.__value = value;
				// we don't set the value if it hasn't changed. This supports invalid number inputs like `1e` because
				// 1. user types 1e
				// 2. the state is updated reading e.target.value which is ''
				// 3. the spreaded value is ''
				// 4. updating input.value would thus, clear the user value
				if (
					prev_value == null ||
					node.value !== value ||
					(value === 0 && element.nodeName === PROGRESS_TAG)
				) {
					node.value = value ?? '';
				}
			} else if (key === 'selected' && is_option_element) {
				set_selected(node, value);
			} else {
				var name = key;
				if (!preserve_attribute_case) {
					name = normalize_attribute(name);
				}

				var is_default = name === 'defaultValue' || name === 'defaultChecked';

				// A select's default value is represented by selected options, not a property.
				if (is_select_element && name === 'defaultValue') continue;

				if (value == null && !is_custom_element && !is_default) {
					attributes[key] = null;

					if (name === 'value') {
						// removing value/checked also removes defaultValue/defaultChecked — preserve
						let default_value = node.defaultValue;
						element.removeAttribute(name);
						set_default_value(node, default_value);
						node.value = (node.__value = prev === undefined ? default_value : null) ?? '';
					} else if (name === 'checked') {
						let default_checked = node.defaultChecked;
						element.removeAttribute(name);
						set_default_checked(node, default_checked);
						node.checked = prev === undefined ? default_checked : false;
					} else {
						element.removeAttribute(key);
					}
				} else if (
					is_default ||
					((is_custom_element || typeof value !== 'string') && setters.has(name))
				) {
					node[name] = value;
					// remove it from attributes's cache
					if (name in attributes) attributes[name] = UNINITIALIZED;
				} else if (typeof value !== 'function') {
					set_attribute(element, name, value, skip_warning);
				}
			}
		}
	} finally {
		if (is_hydrating_custom_element) {
			set_hydrating(true);
		}
	}

	return current;
}

/**
 * `async` and `blockers` only have content with `experimental.async`, which svelte-lite leaves
 * out. They are in the signature because the compiler passes the arguments after them by position.
 */
export function attribute_effect(
	element: Element & ElementCSSInlineStyle,
	fn: (...expressions: any) => Attributes,
	sync: Array<() => any> = [],
	async: Array<() => Promise<any>> = [],
	blockers: Parameters<typeof flatten>[0] = [],
	css_hash?: string,
	should_remove_defaults = false,
	skip_warning = false
): void {
	flatten(blockers, sync, async, (values) => {
		var prev: Attributes | undefined = undefined;
		var effects: Record<symbol, Effect> = {};

		var is_select = element.nodeName === SELECT_TAG;
		var inited = false;

		managed(() => {
			var next = fn(...values.map(get));
			var current = set_attributes(
				element,
				prev,
				next,
				css_hash,
				should_remove_defaults,
				skip_warning
			);

			if (inited && is_select) {
				var select = element as HTMLSelectElement;

				if ('defaultValue' in next) {
					set_default_select_value(select, next.defaultValue);
				}

				if ('value' in next) {
					select_option(select, next.value);
				}
			}

			for (let symbol of Object.getOwnPropertySymbols(effects)) {
				if (!next[symbol]) destroy_effect(effects[symbol]);
			}

			for (let symbol of Object.getOwnPropertySymbols(next)) {
				var n = next[symbol];

				if (symbol.description === ATTACHMENT_KEY && (!prev || n !== prev[symbol])) {
					if (effects[symbol]) destroy_effect(effects[symbol]);
					effects[symbol] = branch(() => attach(element, () => n));
				}

				current[symbol] = n;
			}

			prev = current;
		});

		if (is_select) {
			var select = element as HTMLSelectElement;

			effect(() => {
				var attrs = prev as Attributes;

				if ('defaultValue' in attrs) {
					set_default_select_value(select, attrs.defaultValue);
				}

				select_option(select, attrs.value, true);
				init_select(select);
			});
		}

		inited = true;
	});
}

function get_attributes(element: Element): Attributes {
	return ((element as any)[ATTRIBUTES_CACHE] ??= {
		[IS_CUSTOM_ELEMENT]: element.nodeName.includes('-'),
		[IS_HTML]: element.namespaceURI === NAMESPACE_HTML
	});
}

var setters_cache = new Map<string, Set<string>>();

function get_setters(element: Element): Set<string> {
	var cache_key = element.getAttribute('is') || element.nodeName;
	var setters = setters_cache.get(cache_key);
	if (setters) return setters;
	setters_cache.set(cache_key, (setters = new Set()));

	var descriptors;
	var proto = element; // In the case of custom elements there might be setters on the instance
	var element_proto = Element.prototype;

	// Stop at Element, from there on there's only unnecessary (and dangerous, like innerHTML) setters we're not interested in
	// Do not use constructor.name here as that's unreliable in some browser environments
	while (element_proto !== proto) {
		descriptors = get_descriptors(proto);

		for (var key in descriptors) {
			if (
				descriptors[key].set &&
				// better safe than sorry, we don't want spread attributes to mess with HTML content
				key !== 'innerHTML' &&
				key !== 'textContent' &&
				key !== 'innerText'
			) {
				setters.add(key);
			}
		}

		proto = get_prototype_of(proto);
	}

	return setters;
}

function check_src_in_dev_hydration(element: any, attribute: string, value: string) {
	if (!DEV) return;
	if (attribute === 'srcset' && srcset_url_equal(element, value)) return;
	if (src_url_equal(element.getAttribute(attribute) ?? '', value)) return;

	w.hydration_attribute_changed(
		attribute,
		element.outerHTML.replace(element.innerHTML, element.innerHTML && '...'),
		String(value)
	);
}

function src_url_equal(element_src: string, url: string): boolean {
	if (element_src === url) return true;
	return new URL(element_src, document.baseURI).href === new URL(url, document.baseURI).href;
}

function split_srcset(srcset: string) {
	return srcset.split(',').map((src) => src.trim().split(' ').filter(Boolean));
}

function srcset_url_equal(element: HTMLSourceElement | HTMLImageElement, srcset: string): boolean {
	var element_urls = split_srcset(element.srcset);
	var urls = split_srcset(srcset);

	return (
		urls.length === element_urls.length &&
		urls.every(
			([url, width], i) =>
				width === element_urls[i][1] &&
				// We need to test both ways because Vite will create an a full URL with
				// `new URL(asset, import.meta.url).href` for the client when `base: './'`, and the
				// relative URLs inside srcset are not automatically resolved to absolute URLs by
				// browsers (in contrast to img.src). This means both SSR and DOM code could
				// contain relative or absolute URLs.
				(src_url_equal(element_urls[i][0], url) || src_url_equal(url, element_urls[i][0]))
		)
	);
}
