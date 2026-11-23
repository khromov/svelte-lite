import type { TemplateNode } from '../types.ts';
import { DEV } from 'esm-env';
import { NAMESPACE_HTML } from '../../../constants.ts';
import { get_descriptor, is_extensible } from '../../shared/utils.ts';
import {
	ATTRIBUTES_CACHE,
	CLASS_CACHE,
	STYLE_CACHE,
	TEXT_CACHE,
	TEXT_NODE
} from '../constants.ts';
import { init_array_prototype_warnings } from '../dev/equality.ts';
import { hydrate_node, hydrating, reset, set_hydrate_node } from './hydration.ts';

// export these for reference in the compiled code, making global name deduplication unnecessary
export var $window: Window;

export var $document: Document;

export var is_firefox: boolean;

var first_child_getter: (this: Node) => Node | null;
var next_sibling_getter: (this: Node) => Node | null;

/**
 * Initialize these lazily to avoid issues when using the runtime in a server context
 * where these globals are not available while avoiding a separate server entry point
 */
export function init_operations(): void {
	if ($window !== undefined) {
		return;
	}

	$window = window;
	$document = document;
	is_firefox = /Firefox/.test(navigator.userAgent);

	var element_prototype: any = Element.prototype;
	var node_prototype = Node.prototype;
	var text_prototype: any = Text.prototype;

	first_child_getter = get_descriptor(node_prototype, 'firstChild')!.get!;
	next_sibling_getter = get_descriptor(node_prototype, 'nextSibling')!.get!;

	if (is_extensible(element_prototype)) {
		// the following assignments improve perf of lookups on DOM nodes
		element_prototype[CLASS_CACHE] = undefined;
		element_prototype[ATTRIBUTES_CACHE] = null;
		element_prototype[STYLE_CACHE] = undefined;
		element_prototype.__e = undefined;
	}

	if (is_extensible(text_prototype)) {
		text_prototype[TEXT_CACHE] = undefined;
	}

	if (DEV) {
		element_prototype.__svelte_meta = null;

		init_array_prototype_warnings();
	}
}

// Svelte routes every DOM access through the helpers in this module, so that a custom
// renderer can take over. svelte-lite has no custom renderers: each helper is the plain
// DOM operation, and is kept under its name for the modules that call it.

export function create_text(value: string = ''): Text {
	return document.createTextNode(value);
}

/*@__NO_SIDE_EFFECTS__*/
export function get_first_child(node: Node): TemplateNode | null {
	return first_child_getter.call(node) as TemplateNode | null;
}

/*@__NO_SIDE_EFFECTS__*/
export function get_next_sibling(node: Node): TemplateNode | null {
	return next_sibling_getter.call(node) as TemplateNode | null;
}

/**
 * Don't mark this as side-effect-free, hydration needs to walk all nodes
 */
export function child(node: Node, is_text?: boolean): TemplateNode | null {
	if (!hydrating) {
		return get_first_child(node);
	}

	var child = get_first_child(hydrate_node);

	// Child can be null if we have an element with a single child, like `<p>{text}</p>`, where `text` is empty
	if (child === null) {
		child = hydrate_node.appendChild(create_text());
	} else if (is_text && child.nodeType !== TEXT_NODE) {
		var text = create_text();
		child.before(text);
		set_hydrate_node(text);
		return text;
	}

	if (is_text) {
		merge_text_nodes(child as Text);
	}

	set_hydrate_node(child);
	return child;
}

/**
 * Don't mark this as side-effect-free, hydration needs to walk all nodes
 */
export function first_child(node: Node, is_text: boolean = false): TemplateNode | null {
	if (!hydrating) {
		var first = get_first_child(node);

		// TODO prevent user comments with the empty string when preserveComments is true
		if (first instanceof Comment && first.nodeValue === '') return get_next_sibling(first);

		return first;
	}

	if (is_text) {
		// if an {expression} is empty during SSR, there might be no
		// text node to hydrate — we must therefore create one
		if (hydrate_node?.nodeType !== TEXT_NODE) {
			var text = create_text();

			hydrate_node?.before(text);
			set_hydrate_node(text);
			return text;
		}

		merge_text_nodes(hydrate_node as Text);
	}

	return hydrate_node;
}

/**
 * `child`, for the very common case of an element with exactly one child. Resetting the
 * hydration cursor is part of the same step, so the compiler doesn't have to emit a
 * separate `reset` call for every `<p>{text}</p>` in an app.
 * Don't mark this as side-effect-free, hydration needs to walk all nodes
 */
export function only_child(node: TemplateNode, is_text: boolean = false): TemplateNode | null {
	if (!hydrating) {
		return get_first_child(node);
	}

	var first = child(node, is_text);
	reset(node);

	return first;
}

/**
 * Don't mark this as side-effect-free, hydration needs to walk all nodes
 */
export function sibling(
	node: TemplateNode,
	count: number = 1,
	is_text: boolean = false
): TemplateNode | null {
	var next_sibling: TemplateNode | null = hydrating ? hydrate_node : node;
	var last_sibling: TemplateNode | undefined;

	while (count--) {
		last_sibling = next_sibling as TemplateNode;
		next_sibling = get_next_sibling(next_sibling as TemplateNode);
	}

	if (!hydrating) {
		return next_sibling;
	}

	if (is_text) {
		// if a sibling {expression} is empty during SSR, there might be no
		// text node to hydrate — we must therefore create one
		if (next_sibling?.nodeType !== TEXT_NODE) {
			var text = create_text();
			// If the next sibling is `null` and we're handling text then it's because
			// the SSR content was empty for the text, so we need to generate a new text
			// node and insert it after the last sibling
			if (next_sibling === null) {
				last_sibling?.after(text);
			} else {
				next_sibling.before(text);
			}
			set_hydrate_node(text);
			return text;
		}

		merge_text_nodes(next_sibling as Text);
	}

	set_hydrate_node(next_sibling);
	return next_sibling;
}

export function clear_text_content(node: Node): void {
	node.textContent = '';
}

/**
 * Branching here is intentional and load-bearing for perf. `createElement(tag)`
 * hits a fast path in Blink that `createElementNS(NAMESPACE_HTML, tag)` doesn't,
 * and passing an explicit `undefined` as the trailing options arg measurably
 * slows both APIs. Funnelling every case through a single `createElementNS(ns,
 * tag, options)` call would be smaller but slower on the HTML path.
 */
export function create_element<T extends keyof HTMLElementTagNameMap | string>(
	tag: T,
	namespace?: string | null,
	is?: string
): T extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[T] : Element {
	var element: Element;

	if (namespace == null || namespace === NAMESPACE_HTML) {
		element = is ? document.createElement(tag, { is }) : document.createElement(tag);
	} else {
		element = is
			? document.createElementNS(namespace, tag, { is })
			: document.createElementNS(namespace, tag);
	}

	return element as T extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[T] : Element;
}

export function create_fragment(): DocumentFragment {
	return document.createDocumentFragment();
}

export function create_comment(data: string = ''): Comment {
	return document.createComment(data);
}

export function set_attribute(element: Element, key: string, value: string = ''): void {
	if (key.startsWith('xlink:')) {
		element.setAttributeNS('http://www.w3.org/1999/xlink', key, value);
		return;
	}
	return element.setAttribute(key, value);
}

/**
 * Browsers split text nodes larger than 65536 bytes when parsing.
 * For hydration to succeed, we need to stitch them back together
 */
export function merge_text_nodes(text: Text): void {
	if (text.nodeValue!.length < 65536) {
		return;
	}

	let next = text.nextSibling;

	while (next !== null && next.nodeType === TEXT_NODE) {
		next.remove();

		text.nodeValue! += next.nodeValue!;

		next = text.nextSibling;
	}
}

export function node_type(node: Node | null | undefined): number | undefined {
	return node?.nodeType;
}

export function node_name(node: Node): string {
	return node.nodeName;
}

export function get_last_child(node: Node): TemplateNode | null {
	return node.lastChild as TemplateNode | null;
}

export function get_parent_node(node: Node): TemplateNode | null {
	return node.parentNode as TemplateNode | null;
}

export function append_child<N extends Node>(parent: Node, child: N): N {
	return parent.appendChild(child);
}

/**
 * Insert `new_node` before `ref_node` (equivalent to `ref_node.before(new_node)`)
 */
export function insert_before(ref_node: ChildNode, new_node: Node): void {
	ref_node.before(new_node);
}

/**
 * Insert `new_node` after `ref_node` (equivalent to `ref_node.after(new_node)`)
 */
export function insert_after(ref_node: ChildNode, new_node: Node): void {
	ref_node.after(new_node);
}

export function remove_node(node: ChildNode): void {
	node.remove();
}

export function remove_child<N extends ChildNode>(parent: Node, child: N): N {
	return parent.removeChild(child);
}

export function replace_with(old_node: ChildNode, new_node: Node): void {
	old_node.replaceWith(new_node);
}

export function set_text_content(node: Node, value: string): void {
	node.textContent = value;
}

export function set_node_value(node: Node, value: string): void {
	node.nodeValue = value;
}

export function get_node_value(node: Node): string | null {
	return node.nodeValue;
}

/**
 * Sets the `value` property on an element
 */
export function set_element_value(element: Element, value: any): void {
	(element as HTMLInputElement).value = value ?? '';
}

/**
 * Sets the `checked` property on an element
 */
export function set_element_checked(element: Element, checked: boolean): void {
	(element as HTMLInputElement).checked = checked;
}

/**
 * Sets the `defaultValue` property on an element without affecting the current `value`
 */
export function set_element_default_value(element: Element, value: string): void {
	const input = element as HTMLInputElement;
	const existing_value = input.value;
	input.defaultValue = value;
	input.value = existing_value;
}

/**
 * Sets the `defaultChecked` property on an element without affecting the current `checked` state
 */
export function set_element_default_checked(element: Element, checked: boolean): void {
	const input = element as HTMLInputElement;
	const existing_value = input.checked;
	input.defaultChecked = checked;
	input.checked = existing_value;
}

export function get_attribute(element: Element, name: string): string | null {
	return element.getAttribute(name);
}

export function remove_attribute(element: Element, name: string): void {
	element.removeAttribute(name);
}

export function has_attribute(element: Element, name: string): boolean {
	return element.hasAttribute(name);
}

export function set_inner_html(element: Element, value: string): void {
	element.innerHTML = value;
}

export function clone_node(node: Node, deep: boolean): Node {
	return node.cloneNode(deep);
}

export function import_node(node: Node, deep: boolean): Node {
	return document.importNode(node, deep);
}

export function add_event_listener(
	target: EventTarget,
	type: string,
	handler: EventListenerOrEventListenerObject,
	options?: boolean | AddEventListenerOptions
): void {
	target.addEventListener(type, handler, options);
}

export function remove_event_listener(
	target: EventTarget,
	type: string,
	handler: EventListenerOrEventListenerObject,
	options?: boolean | EventListenerOptions
): void {
	target.removeEventListener(type, handler, options);
}

export function dispatch_event(target: EventTarget, event: Event): boolean {
	return target.dispatchEvent(event);
}

export function style_set_property(
	element: HTMLElement,
	property: string,
	value: string,
	priority?: string
): void {
	element.style.setProperty(property, value, priority);
}

export function style_remove_property(element: HTMLElement, property: string): void {
	element.style.removeProperty(property);
}

export function set_css_text(element: HTMLElement, value: string): void {
	element.style.cssText = value;
}

export function class_list_toggle(element: Element, name: string, force: boolean): void {
	element.classList.toggle(name, force);
}
