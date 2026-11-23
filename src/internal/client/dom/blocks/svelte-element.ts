import type { Effect, EffectNodes, TemplateNode } from '../../types.ts';
import { DEV } from 'esm-env';
import { FILENAME, NAMESPACE_SVG } from '../../../../constants.ts';
import { is_raw_text_element } from '../../../../utils.ts';
import { EFFECT_TRANSPARENT, ELEMENT_NODE } from '../../constants.ts';
import { component_context, dev_stack } from '../../context.ts';
import { block, teardown } from '../../reactivity/effects.ts';
import { set_should_intro } from '../../render.ts';
import { active_effect } from '../../runtime.ts';
import { set_animation_effect_override } from '../elements/transitions.ts';
import {
	hydrate_next,
	hydrate_node,
	hydrating,
	set_hydrate_node,
	set_hydrating
} from '../hydration.ts';
import { create_comment, create_element, create_text, get_first_child } from '../operations.ts';
import { assign_nodes } from '../template.ts';
import { BranchManager } from './branches.ts';

/**
 * @param location the line and column of the element
 */
export function element(
	node: Comment | Element,
	get_tag: () => string,
	is_svg: boolean,
	render_fn?: (element: Element, anchor: Node | null) => void,
	get_namespace?: () => string,
	location?: [number, number]
): void {
	let was_hydrating = hydrating;

	if (hydrating) {
		hydrate_next();
	}

	var filename = DEV && location && component_context?.function[FILENAME];

	var element: null | Element = null;

	if (hydrating && hydrate_node.nodeType === ELEMENT_NODE) {
		element = hydrate_node as Element;
		hydrate_next();
	}

	var anchor: TemplateNode = hydrating ? hydrate_node : node;

	/**
	 * We track this so we can set it when changing the element, allowing any
	 * `animate:` directive to bind itself to the correct block
	 */
	var parent_effect = active_effect as Effect;

	var branches = new BranchManager<string | null>(anchor, false);

	block(() => {
		const next_tag = get_tag() || null;
		var ns = get_namespace
			? get_namespace()
			: is_svg || next_tag === 'svg'
				? NAMESPACE_SVG
				: undefined;

		if (next_tag === null) {
			branches.ensure(null, null);
			set_should_intro(true);
			return;
		}

		branches.ensure(next_tag, (anchor) => {
			if (next_tag) {
				var is_hydrating = hydrating;
				element = hydrating ? (element as Element) : create_element(next_tag, ns);

				if (DEV && location) {
					// @ts-expect-error
					element.__svelte_meta = {
						parent: dev_stack,
						loc: {
							file: filename,
							line: location[0],
							column: location[1]
						},
						component: component_context
					};
				}

				assign_nodes(element, element);

				if (render_fn) {
					var tmp_comment = null;

					if (hydrating && is_raw_text_element(next_tag)) {
						// prevent hydration glitches (code just below expects an anchor)
						element.appendChild((tmp_comment = create_comment('')));
					}

					// If hydrating, use the existing ssr comment as the anchor so that the
					// inner open and close methods can pick up the existing nodes correctly
					var child_anchor = hydrating
						? get_first_child(element)
						: element.appendChild(create_text());

					if (hydrating) {
						if (child_anchor === null) {
							set_hydrating(false);
						} else {
							set_hydrate_node(child_anchor);
						}
					}

					set_animation_effect_override(parent_effect);

					// `child_anchor` is undefined if this is a void element, but we still
					// need to call `render_fn` in order to run actions etc. If the element
					// contains children, it's a user error (which is warned on elsewhere)
					// and the DOM will be silently discarded
					render_fn(element, child_anchor);

					if (tmp_comment) {
						element.removeChild(tmp_comment);
					}

					set_animation_effect_override(null);
				}

				// we do this after calling `render_fn` so that child effects don't override `nodes.end`
				(active_effect as Effect & { nodes: EffectNodes }).nodes.end = element;

				// we only move the node if we are not hydrating since a claimed element is already in place
				if (!is_hydrating) anchor.before(element);
			}

			if (hydrating) {
				set_hydrate_node(anchor);
			}
		});

		// revert to the default state after the effect has been created
		set_should_intro(true);

		return () => {
			if (next_tag) {
				// if we're in this callback because we're re-running the effect,
				// disable intros (unless no element is currently displayed)
				set_should_intro(false);
			}
		};
	}, EFFECT_TRANSPARENT);

	teardown(() => {
		set_should_intro(true);
	});

	if (was_hydrating) {
		set_hydrating(true);
		set_hydrate_node(anchor);
	}
}
