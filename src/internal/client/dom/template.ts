import type { Effect, EffectNodes, TemplateNode } from '../types.ts';
import type { TemplateStructure } from './types.ts';
import {
	NAMESPACE_MATHML,
	NAMESPACE_SVG,
	TEMPLATE_FRAGMENT,
	TEMPLATE_USE_IMPORT_NODE,
	TEMPLATE_USE_MATHML,
	TEMPLATE_USE_SVG
} from '../../../constants.ts';
import { COMMENT_NODE, DOCUMENT_FRAGMENT_NODE, IS_XHTML, TEXT_NODE } from '../constants.ts';
import { active_effect } from '../runtime.ts';
import { hydrate_next, hydrate_node, hydrating, set_hydrate_node } from './hydration.ts';
import {
	create_comment,
	create_element,
	create_fragment,
	create_text,
	get_first_child,
	is_firefox,
	merge_text_nodes,
	set_attribute
} from './operations.ts';
import { create_fragment_from_html } from './reconciler.ts';

const TEMPLATE_TAG = IS_XHTML ? 'template' : 'TEMPLATE';
const SCRIPT_TAG = IS_XHTML ? 'script' : 'SCRIPT';

export function assign_nodes(start: TemplateNode, end: TemplateNode | null): void {
	var effect = active_effect as Effect;
	if (effect.nodes === null) {
		effect.nodes = { start, end, a: null, t: null };
	}
}

/*#__NO_SIDE_EFFECTS__*/
export function from_html(content: string, flags: number): () => Node | Node[] {
	var is_fragment = (flags & TEMPLATE_FRAGMENT) !== 0;
	var use_import_node = (flags & TEMPLATE_USE_IMPORT_NODE) !== 0;

	var node: Node | undefined;

	/**
	 * Whether or not the first item is a text/element node. If not, we need to
	 * create an additional comment node to act as `effect.nodes.start`
	 */
	var has_start = !content.startsWith('<!>');

	return () => {
		if (hydrating) {
			assign_nodes(hydrate_node, null);
			return hydrate_node;
		}

		if (node === undefined) {
			node = create_fragment_from_html(has_start ? content : '<!>' + content);
			if (!is_fragment) node = get_first_child(node) as TemplateNode;
		}

		var clone = (
			use_import_node || is_firefox ? document.importNode(node, true) : node.cloneNode(true)
		) as TemplateNode;

		if (is_fragment) {
			var start = get_first_child(clone) as TemplateNode;
			var end = clone.lastChild as TemplateNode;

			assign_nodes(start, end);
		} else {
			assign_nodes(clone, clone);
		}

		return clone;
	};
}

/*#__NO_SIDE_EFFECTS__*/
function from_namespace(
	content: string,
	flags: number,
	ns: 'svg' | 'math' = 'svg'
): () => Node | Node[] {
	/**
	 * Whether or not the first item is a text/element node. If not, we need to
	 * create an additional comment node to act as `effect.nodes.start`
	 */
	var has_start = !content.startsWith('<!>');

	var is_fragment = (flags & TEMPLATE_FRAGMENT) !== 0;
	var wrapped = `<${ns}>${has_start ? content : '<!>' + content}</${ns}>`;

	var node: Element | DocumentFragment | undefined;

	return () => {
		if (hydrating) {
			assign_nodes(hydrate_node, null);
			return hydrate_node;
		}

		if (!node) {
			var fragment = create_fragment_from_html(wrapped);
			var root = get_first_child(fragment) as Element;

			if (is_fragment) {
				node = create_fragment();
				while (get_first_child(root)) {
					node.appendChild(get_first_child(root) as TemplateNode);
				}
			} else {
				node = get_first_child(root) as Element;
			}
		}

		var clone = node.cloneNode(true) as TemplateNode;

		if (is_fragment) {
			var start = get_first_child(clone) as TemplateNode;
			var end = clone.lastChild as TemplateNode;

			assign_nodes(start, end);
		} else {
			assign_nodes(clone, clone);
		}

		return clone;
	};
}

/*#__NO_SIDE_EFFECTS__*/
export function from_svg(content: string, flags: number): () => Node | Node[] {
	return from_namespace(content, flags, 'svg');
}

/*#__NO_SIDE_EFFECTS__*/
export function from_mathml(content: string, flags: number): () => Node | Node[] {
	return from_namespace(content, flags, 'math');
}

function fragment_from_tree(
	structure: TemplateStructure[],
	ns?: typeof NAMESPACE_SVG | typeof NAMESPACE_MATHML
): DocumentFragment {
	var fragment = create_fragment();

	for (var item of structure) {
		if (typeof item === 'string') {
			fragment.appendChild(create_text(item));
			continue;
		}

		// if `preserveComments === true`, comments are represented as `['// <data>']`
		if (item === undefined || item[0][0] === '/') {
			fragment.appendChild(create_comment(item ? item[0].slice(3) : ''));
			continue;
		}

		const [name, attributes, ...children] = item;

		const namespace = name === 'svg' ? NAMESPACE_SVG : name === 'math' ? NAMESPACE_MATHML : ns;

		var element = create_element(name, namespace, attributes?.is);

		for (var key in attributes) {
			set_attribute(element, key, attributes[key]);
		}

		if (children.length > 0) {
			var target =
				element.nodeName === TEMPLATE_TAG ? (element as HTMLTemplateElement).content : element;

			target.appendChild(
				fragment_from_tree(children, element.nodeName === 'foreignObject' ? undefined : namespace)
			);
		}

		fragment.appendChild(element);
	}

	return fragment;
}

/*#__NO_SIDE_EFFECTS__*/
export function from_tree(structure: TemplateStructure[], flags: number): () => Node | Node[] {
	var is_fragment = (flags & TEMPLATE_FRAGMENT) !== 0;
	var use_import_node = (flags & TEMPLATE_USE_IMPORT_NODE) !== 0;

	const ns =
		(flags & TEMPLATE_USE_SVG) !== 0
			? NAMESPACE_SVG
			: (flags & TEMPLATE_USE_MATHML) !== 0
				? NAMESPACE_MATHML
				: undefined;

	/** The DOM template that is cloned for each instance */
	var node: Node | undefined;

	return () => {
		if (hydrating) {
			assign_nodes(hydrate_node, null);
			return hydrate_node;
		}

		if (node === undefined) {
			node = fragment_from_tree(structure, ns);
			if (!is_fragment) node = get_first_child(node) as TemplateNode;
		}

		var clone = (
			use_import_node || is_firefox ? document.importNode(node, true) : node.cloneNode(true)
		) as TemplateNode;

		if (is_fragment) {
			var start = get_first_child(clone) as TemplateNode;
			var end = clone.lastChild as TemplateNode;

			assign_nodes(start, end);
		} else {
			assign_nodes(clone, clone);
		}

		return clone;
	};
}

export function with_script(fn: () => Element | DocumentFragment): () => Node | Node[] {
	return () => run_scripts(fn());
}

/**
 * Creating a document fragment from HTML that contains script tags will not execute
 * the scripts. We need to replace the script tags with new ones so that they are executed.
 */
function run_scripts(node: Element | DocumentFragment): Node | Node[] {
	// scripts were SSR'd, in which case they will run
	if (hydrating) return node;

	const is_fragment = node.nodeType === DOCUMENT_FRAGMENT_NODE;
	const scripts =
		node.nodeName === SCRIPT_TAG ? [node as HTMLScriptElement] : node.querySelectorAll('script');

	const effect = active_effect as Effect & { nodes: EffectNodes };

	for (const script of scripts) {
		const clone = create_element('script');

		for (var attribute of script.attributes) {
			set_attribute(clone, attribute.name, attribute.value);
		}

		clone.textContent = script.textContent;

		// The script has changed - if it's at the edges, the effect now points at dead nodes
		if (is_fragment ? node.firstChild === script : node === script) {
			effect.nodes.start = clone;
		}
		if (is_fragment ? node.lastChild === script : node === script) {
			effect.nodes.end = clone;
		}

		script.replaceWith(clone);
	}
	return node;
}

/**
 * Don't mark this as side-effect-free, hydration needs to walk all nodes
 */
export function text(value: any = ''): Text {
	if (!hydrating) {
		var t = create_text(value + '');
		assign_nodes(t, t);
		return t;
	}

	var node = hydrate_node;

	if (node?.nodeType !== TEXT_NODE) {
		// if an {expression} is empty during SSR, we need to insert an empty text node
		node.before((node = create_text()));
		set_hydrate_node(node);
	} else {
		merge_text_nodes(node as Text);
	}

	assign_nodes(node, node);
	return node as Text;
}

export function comment(): TemplateNode | DocumentFragment {
	// we're not delegating to `template` here for performance reasons
	if (hydrating) {
		assign_nodes(hydrate_node, null);
		return hydrate_node;
	}

	var frag = create_fragment();
	var start = create_comment();
	var anchor = create_text();
	frag.append(start, anchor);

	assign_nodes(start, anchor);

	return frag;
}

/**
 * Assign the created (or in hydration mode, traversed) dom elements to the current block
 * and insert the elements into the dom (in client mode).
 */
export function append(
	anchor: Text | Comment | Element | null,
	dom: DocumentFragment | Element
): void {
	if (hydrating) {
		// without async, a component never resumes after its effect has run, so this
		// is always the effect's first run and the end marker can only move forward
		(active_effect as Effect & { nodes: EffectNodes }).nodes.end = hydrate_node;
		hydrate_next();
		return;
	}

	if (anchor === null) {
		// edge case — void `<svelte:element>` with content
		return;
	}

	anchor.before(dom);
}

/**
 * Create (or hydrate) an unique UID for the component instance.
 */
export function props_id(): string {
	var node_value: string | null;

	if (
		hydrating &&
		hydrate_node?.nodeType === COMMENT_NODE &&
		(node_value = hydrate_node.nodeValue)?.startsWith('$')
	) {
		const id = node_value!.substring(1);
		hydrate_next();
		return id;
	}

	// this way we ensure the id is unique even across Svelte runtimes
	var global = globalThis as { __svelte?: { uid?: number } };
	(global.__svelte ??= {}).uid ??= 1;

	return `c${global.__svelte.uid++}`;
}
