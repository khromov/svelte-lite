import type { DevStackEntry, Effect, TemplateNode } from '../../types.ts';
import type {} from 'trusted-types';
import { DEV } from 'esm-env';
import {
	FILENAME,
	HYDRATION_ERROR,
	NAMESPACE_MATHML,
	NAMESPACE_SVG
} from '../../../../constants.ts';
import { hash, sanitize_location } from '../../../../utils.ts';
import { COMMENT_NODE, ELEMENT_NODE } from '../../constants.ts';
import { component_context, dev_current_component_function, dev_stack } from '../../context.ts';
import { remove_effect_dom, template_effect } from '../../reactivity/effects.ts';
import { active_effect } from '../../runtime.ts';
import * as w from '../../warnings.ts';
import { hydrate_next, hydrate_node, hydrating, set_hydrate_node } from '../hydration.ts';
import { create_element, get_first_child, get_next_sibling } from '../operations.ts';
import { assign_nodes } from '../template.ts';

/** The filename, line and column of a tag */
type Location = [string, number, number];

function check_hash(
	server_hash: string | null,
	value: string | TrustedHTML,
	loc: Location | undefined
) {
	if (!server_hash || server_hash === hash(String(value ?? ''))) return;

	let location;

	if (loc) {
		location = `near ${loc[0]}:${loc[1]}:${loc[2]}`;
	} else if (dev_current_component_function?.[FILENAME]) {
		location = `in ${dev_current_component_function[FILENAME]}`;
	}

	w.hydration_html_changed(sanitize_location(location));
}

/**
 * Assigns the location of the `{@html ...}` tag to the top-level elements it created,
 * which also prevents the surrounding template from assigning its locations to them
 */
function assign_locations(effect: Effect, parent: DevStackEntry | null, loc: Location) {
	if (effect.nodes === null) return;

	var node: TemplateNode | null = effect.nodes.start;

	while (node !== null) {
		if (node.nodeType === ELEMENT_NODE) {
			// @ts-expect-error
			node.__svelte_meta = {
				parent,
				loc: { file: loc[0], line: loc[1], column: loc[2] },
				component: component_context
			};
		}

		if (node === effect.nodes.end) break;
		node = get_next_sibling(node);
	}
}

export function html(
	node: Element | Text | Comment,
	get_value: () => string | TrustedHTML,
	is_controlled = false,
	svg = false,
	mathml = false,
	skip_warning = false,
	location?: Location
): void {
	var anchor = node;
	var parent = DEV ? dev_stack : null;

	var value: string | TrustedHTML = '';

	if (is_controlled) {
		var parent_node = node as Element;

		if (hydrating) {
			anchor = set_hydrate_node(get_first_child(parent_node));
		}
	}

	template_effect(() => {
		var effect = active_effect as Effect;

		if (value === (value = get_value() ?? '')) {
			if (hydrating) hydrate_next();
			return;
		}

		if (is_controlled && !hydrating) {
			// When @html is the only child, use innerHTML directly.
			// This also handles contenteditable, where the user may delete the anchor comment.
			effect.nodes = null;
			parent_node.innerHTML = value as string;

			if (value !== '') {
				assign_nodes(
					get_first_child(parent_node) as TemplateNode,
					parent_node.lastChild as TemplateNode
				);

				if (DEV && location) assign_locations(effect, parent, location);
			}

			return;
		}

		if (effect.nodes !== null) {
			remove_effect_dom(effect.nodes.start, effect.nodes.end as TemplateNode);
			effect.nodes = null;
		}

		if (value === '') return;

		if (hydrating) {
			// We're deliberately not trying to repair mismatches between server and client,
			// as it's costly and error-prone (and it's an edge case to have a mismatch anyway)
			var server_hash = hydrate_node.nodeValue;

			var next: TemplateNode | null = hydrate_next();
			var last = next;

			while (next !== null && (next.nodeType !== COMMENT_NODE || next.nodeValue !== '')) {
				last = next;
				next = get_next_sibling(next);
			}

			if (next === null) {
				w.hydration_mismatch();
				throw HYDRATION_ERROR;
			}

			if (DEV && !skip_warning) {
				check_hash(server_hash, value, location);
			}

			assign_nodes(hydrate_node, last);
			if (DEV && location) assign_locations(effect, parent, location);
			anchor = set_hydrate_node(next);
			return;
		}

		// Don't use create_fragment_with_script_from_html here because that would mean script tags are executed.
		// @html is basically `.innerHTML = ...` and that doesn't execute scripts either due to security reasons.
		// Use a <template>, <svg>, or <math> wrapper depending on context. If value is a TrustedHTML object,
		// it will be assigned directly to innerHTML without coercion — this allows {@html policy.createHTML(...)} to work.
		var ns = svg ? NAMESPACE_SVG : mathml ? NAMESPACE_MATHML : undefined;
		var wrapper = create_element(svg ? 'svg' : mathml ? 'math' : 'template', ns) as
			| HTMLTemplateElement
			| SVGElement
			| MathMLElement;

		wrapper.innerHTML = value as string;

		var content: DocumentFragment | Element =
			svg || mathml ? wrapper : (wrapper as HTMLTemplateElement).content;

		assign_nodes(get_first_child(content) as TemplateNode, content.lastChild as TemplateNode);

		if (DEV && location) assign_locations(effect, parent, location);

		if (svg || mathml) {
			while (get_first_child(content)) {
				anchor.before(get_first_child(content) as TemplateNode);
			}
		} else {
			anchor.before(content);
		}
	});
}
