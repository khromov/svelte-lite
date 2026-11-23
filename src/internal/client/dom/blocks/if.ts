import type { TemplateNode } from '../../types.ts';
import { EFFECT_TRANSPARENT } from '../../constants.ts';
import { block } from '../../reactivity/effects.ts';
import {
	hydrate_next,
	hydrate_node,
	hydrating,
	read_hydration_instruction,
	set_hydrate_node,
	set_hydrating,
	skip_nodes
} from '../hydration.ts';
import { BranchManager } from './branches.ts';

/**
 * @param elseif True if this is an `{:else if ...}` block rather than an `{#if ...}`, as that affects which transitions are considered 'local'
 */
export function if_block(
	node: TemplateNode,
	fn: (branch: (fn: (anchor: Node) => void, key?: number | false) => void) => void,
	elseif = false
): void {
	var marker: TemplateNode | undefined;

	if (hydrating) {
		marker = hydrate_node;
		hydrate_next();
	}

	var branches = new BranchManager<number | false>(node);
	var flags = elseif ? EFFECT_TRANSPARENT : 0;

	function update_branch(key: number | false, fn: null | ((anchor: Node) => void)) {
		if (hydrating) {
			var data = read_hydration_instruction(marker as TemplateNode);

			// "[n" = branch n, "[-1" = else
			if (key !== parseInt(data.substring(1))) {
				// Hydration mismatch: remove everything inside the anchor and start fresh.
				// This could happen with `{#if browser}...{/if}`, for example
				var anchor = skip_nodes();

				set_hydrate_node(anchor);
				branches.anchor = anchor;

				set_hydrating(false);
				branches.ensure(key, fn);
				set_hydrating(true);

				return;
			}
		}

		branches.ensure(key, fn);
	}

	block(() => {
		var has_branch = false;

		fn((fn, key = 0) => {
			has_branch = true;
			update_branch(key, fn);
		});

		if (!has_branch) {
			update_branch(-1, null);
		}
	}, flags);
}
