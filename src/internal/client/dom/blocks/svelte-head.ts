import type { TemplateNode } from '../../types.ts';
import { COMMENT_NODE, HEAD_EFFECT } from '../../constants.ts';
import { block, branch } from '../../reactivity/effects.ts';
import { hydrate_node, hydrating, set_hydrate_node, set_hydrating } from '../hydration.ts';
import { create_text, get_first_child, get_next_sibling } from '../operations.ts';

export function head(hash: string, render_fn: (anchor: Node) => void): void {
	// The head function may be called after the first hydration pass and ssr comment nodes may still be present,
	// therefore we need to skip that when we detect that we're not in hydration mode.
	let previous_hydrate_node = null;
	let was_hydrating = hydrating;

	var anchor: Comment | Text;

	if (hydrating) {
		previous_hydrate_node = hydrate_node;

		var head_anchor = get_first_child(document.head);

		// There might be multiple head blocks in our app, and they could have been
		// rendered in an arbitrary order — find one corresponding to this component
		while (
			head_anchor !== null &&
			(head_anchor.nodeType !== COMMENT_NODE || head_anchor.nodeValue !== hash)
		) {
			head_anchor = get_next_sibling(head_anchor);
		}

		// If we can't find an opening hydration marker, skip hydration (this can happen
		// if a framework rendered body but not head content)
		if (head_anchor === null) {
			set_hydrating(false);
		} else {
			var start = get_next_sibling(head_anchor) as TemplateNode;
			head_anchor.remove(); // in case this component is repeated

			set_hydrate_node(start);
		}
	}

	if (!hydrating) {
		anchor = document.head.appendChild(create_text());
	}

	try {
		block(() => {
			var e = branch(() => render_fn(anchor));
			e.f |= HEAD_EFFECT;

			if (!hydrating) {
				if (e.nodes === null) {
					e.nodes = { start: anchor, end: anchor, a: null, t: null };
				} else {
					e.nodes.end = anchor;
				}
			}
		});
	} finally {
		if (was_hydrating) {
			set_hydrating(true);
			set_hydrate_node(previous_hydrate_node as TemplateNode);
		}
	}
}
