import { DEV } from 'esm-env';
import { UNINITIALIZED } from '../../../../constants.ts';
import { is_capture_event } from '../../../../utils.ts';
import { get_descriptors, get_prototype_of } from '../../../shared/utils.ts';
import {
	ATTRIBUTES_CACHE,
	FORM_RESET_HANDLER,
	IS_XHTML,
	LOADING_ATTR_SYMBOL
} from '../../constants.ts';
import { expressions, managed } from '../../reactivity/effects.ts';
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
import { create_event } from './events.ts';
import { add_form_reset_listener } from './misc.ts';

/**
 * What a spread is given: attributes by name, plus `CLASS`, `STYLE` and attachments
 * (`createAttachmentKey()`) by symbol. Only what is under a name is applied
 */
type Attributes = Record<string | symbol, any>;

/** The key the compiler puts the `class:` directives of an element with a spread under */
export const CLASS = Symbol('class');
/** The key the compiler puts the `style:` directives of an element with a spread under */
export const STYLE = Symbol('style');

const LINK_TAG = IS_XHTML ? 'link' : 'LINK';
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
 * Spreads attributes onto a DOM element, taking into account the currently set attributes.
 * A key is an event handler (`on...`), a property (if the element has a setter for it and the
 * value is not a string) or an attribute, and `null` or `undefined` removes the attribute.
 * No element is treated differently from another, and of the keys only `style` and `value` are.
 * A key is used as it is written: `readonly` is the attribute and `readOnly` the property
 * @param next New attributes - this function mutates this object
 */
function set_attributes(
	element: Element & ElementCSSInlineStyle,
	prev: Attributes | undefined,
	next: Attributes,
	css_hash?: string,
	skip_warning = false
): Attributes {
	var attributes = get_attributes(element);
	var current = prev || {};

	for (var key in prev) {
		// don't null our internal $$onX listeners
		if (!(key in next) && key[0] + key[1] !== '$$') {
			next[key] = null;
		}
	}

	if (css_hash) {
		// `class` is a string like any other attribute here (and so is `style`), with the hash
		// that scopes the component's styles added to it. Objects, arrays and `class:` directives
		// are not applied
		next.class = next.class ? next.class + ' ' + css_hash : css_hash;
	}

	var setters = get_setters(element);

	// since key is captured we use const
	for (const key in next) {
		// let instead of var because referenced in a closure
		let value = next[key];

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

			if (is_capture_event(event_name)) {
				event_name = event_name.slice(0, -7);
				opts.capture = true;
			}

			if (prev_value) {
				// Listening to same event but different handler -> our handle function below takes care of this
				// If we were to remove and add listeners in this case, it could happen that the event is "swallowed"
				// (the browser seems to not know yet that a new one exists now) and doesn't reach the handler
				// https://github.com/sveltejs/svelte/issues/11903
				if (value != null) continue;

				element.removeEventListener(event_name, current[event_handle_key], opts);
				current[event_handle_key] = null;
			}

			if (value != null) {
				function handle(this: any, ...args: any[]) {
					current[key].apply(this, args);
				}

				current[event_handle_key] = create_event(event_name, element, handle, opts);
			}
		} else if (value == null) {
			attributes[key] = null;
			element.removeAttribute(key);
		} else if (
			// `style` goes through its setter also as a string, because a content security
			// policy can forbid the attribute. So does `value`, because the attribute of an
			// input is only where it starts
			(typeof value !== 'string' || key === 'style' || key === 'value') &&
			setters.has(key)
		) {
			// a string that the element has as its `value` already is not assigned again:
			// `1e` typed into a number input reads as '', and assigning '' would clear it
			if (key !== 'value' || (element as any).value !== value || typeof value !== 'string') {
				(element as any)[key] = value;
				// remove it from attributes's cache
				if (key in attributes) attributes[key] = UNINITIALIZED;
			}
		} else if (typeof value !== 'function') {
			set_attribute(element, key, value, skip_warning);
		}
	}

	return current;
}

/**
 * `async` and `blockers` only have content with `experimental.async`, which svelte-lite leaves
 * out, and `should_remove_defaults` asks for something a spread does not do here. They are in
 * the signature because the compiler passes the arguments after them by position.
 */
export function attribute_effect(
	element: Element & ElementCSSInlineStyle,
	fn: (...expressions: any) => Attributes,
	sync?: Array<() => any>,
	async?: unknown,
	blockers?: unknown,
	css_hash?: string,
	should_remove_defaults?: boolean,
	skip_warning = false
): void {
	// only with expressions to memoize, so that an app whose spreads have none, and which has
	// no other use for deriveds, does not get them from here
	var values = sync && expressions(sync);
	var prev: Attributes | undefined = undefined;

	managed(() => {
		prev = set_attributes(
			element,
			prev,
			values ? fn(...values.map(get)) : fn(),
			css_hash,
			skip_warning
		);
	});
}

function get_attributes(element: Element): Attributes {
	return ((element as any)[ATTRIBUTES_CACHE] ??= {});
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
