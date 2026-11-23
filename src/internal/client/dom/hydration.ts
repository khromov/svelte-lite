import type { TemplateNode } from '../types.ts';
import {
	HYDRATION_END,
	HYDRATION_ERROR,
	HYDRATION_START,
	HYDRATION_START_ELSE,
	HYDRATION_START_FAILED
} from '../../../constants.ts';
import { COMMENT_NODE } from '../constants.ts';
import * as w from '../warnings.ts';
import { get_next_sibling } from './operations.ts';

/**
 * Use this variable to guard everything related to hydration code so it can be treeshaken out
 * if the user doesn't use the `hydrate` method and these code paths are therefore not needed.
 */
export let hydrating = false;

export function set_hydrating(value: boolean): void {
	hydrating = value;
}

/**
 * The node that is currently being hydrated. This starts out as the first node inside the opening
 * <!--[--> comment, and updates each time a component calls `$.child(...)` or `$.sibling(...)`.
 * When entering a block (e.g. `{#if ...}`), `hydrate_node` is the block opening comment; by the
 * time we leave the block it is the closing comment, which serves as the block's anchor.
 */
export let hydrate_node: TemplateNode;

export function set_hydrate_node(node: TemplateNode | null): TemplateNode {
	if (node === null) {
		w.hydration_mismatch();
		throw HYDRATION_ERROR;
	}

	return (hydrate_node = node);
}

export function hydrate_next(): TemplateNode {
	return set_hydrate_node(get_next_sibling(hydrate_node));
}

export function reset(node: TemplateNode): void {
	if (!hydrating) return;

	// If the node has remaining siblings, something has gone wrong
	if (get_next_sibling(hydrate_node) !== null) {
		w.hydration_mismatch();
		throw HYDRATION_ERROR;
	}

	hydrate_node = node;
}

export function hydrate_template(template: HTMLTemplateElement): void {
	if (hydrating) {
		// TemplateNode doesn't include DocumentFragment, but it's actually fine
		hydrate_node = template.content as unknown as TemplateNode;
	}
}

export function next(count: number = 1): void {
	if (hydrating) {
		var i = count;
		var node = hydrate_node;

		while (i--) {
			node = get_next_sibling(node) as TemplateNode;
		}

		hydrate_node = node;
	}
}

/**
 * Skips or removes (depending on {@link remove}) all nodes starting at `hydrate_node` up until the next hydration end comment
 */
export function skip_nodes(remove: boolean = true): TemplateNode {
	var depth = 0;
	var node = hydrate_node;

	while (true) {
		if (node?.nodeType === COMMENT_NODE) {
			var data = node.nodeValue ?? '';

			if (data === HYDRATION_END) {
				if (depth === 0) return node;
				depth -= 1;
			} else if (
				data === HYDRATION_START ||
				data === HYDRATION_START_ELSE ||
				// "[?" followed by the serialized error, for failed boundaries
				data.startsWith(HYDRATION_START_FAILED) ||
				// "[1", "[2", etc. for if blocks
				(data[0] === '[' && !isNaN(Number(data.slice(1))))
			) {
				depth += 1;
			}
		}

		var next = get_next_sibling(node) as TemplateNode;
		if (remove) node.remove();
		node = next;
	}
}

export function read_hydration_instruction(node: TemplateNode): string {
	if (node?.nodeType !== COMMENT_NODE) {
		w.hydration_mismatch();
		throw HYDRATION_ERROR;
	}

	return node.nodeValue ?? '';
}
