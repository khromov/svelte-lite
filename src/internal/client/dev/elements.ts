import type { SourceLocation } from '../types.ts';
import { COMMENT_NODE, DOCUMENT_FRAGMENT_NODE, ELEMENT_NODE } from '../constants.ts';
import { HYDRATION_END, HYDRATION_START } from '../../../constants.ts';
import { hydrating } from '../dom/hydration.ts';
import { component_context, dev_stack } from '../context.ts';
import { get_first_child, get_next_sibling } from '../dom/operations.ts';

/** A template function as `add_locations` returns it, which is what compiled output calls in dev mode */
type LocatedTemplate = {
	(): DocumentFragment | Element;
	hydrate_assign_locations: (node: Node) => void;
};

/**
 * Assign locations immediately after cloning, before blocks or child components insert elements.
 * During hydration, the compiler calls the factory's `hydrate_assign_locations` method after the
 * template's children have their own locations and can be skipped.
 */
export function add_locations(
	fn: () => DocumentFragment | Element,
	filename: string,
	locations: SourceLocation[]
): LocatedTemplate {
	var create = (() => {
		var dom = fn();

		if (!hydrating) {
			assign_locations(
				dom.nodeType === DOCUMENT_FRAGMENT_NODE ? get_first_child(dom) : dom,
				filename,
				locations
			);
		}

		return dom;
	}) as LocatedTemplate;

	create.hydrate_assign_locations = (node) => {
		// Pass the node explicitly because the same factory can be called repeatedly (e.g. in each blocks).
		if (hydrating) assign_locations(node, filename, locations);
	};

	return create;
}

function assign_location(element: Element, filename: string, location: SourceLocation): void {
	// @ts-expect-error
	element.__svelte_meta = {
		parent: dev_stack,
		loc: { file: filename, line: location[0], column: location[1] },
		component: component_context
	};

	if (location[2]) {
		assign_locations(get_first_child(element), filename, location[2]);
	}
}

function assign_locations(node: Node | null, filename: string, locations: SourceLocation[]): void {
	var i = 0;
	var depth = 0;

	while (node && i < locations.length) {
		if (hydrating && node.nodeType === COMMENT_NODE) {
			var comment = node as Comment;
			const data = comment.nodeValue ?? '';
			if (data[0] === HYDRATION_START) depth += 1;
			else if (data[0] === HYDRATION_END) depth -= 1;
		}

		// @ts-expect-error
		if (depth === 0 && node.nodeType === ELEMENT_NODE && !node.__svelte_meta) {
			assign_location(node as Element, filename, locations[i++]);
		}

		node = get_next_sibling(node);
	}
}
