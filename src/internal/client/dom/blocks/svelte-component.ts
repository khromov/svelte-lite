import type { Dom, TemplateNode } from '../../types.ts';
import { HYDRATION_START } from '../../../../constants.ts';
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

export function component<P, C extends (props: P) => void>(
	node: TemplateNode,
	get_component: () => C,
	render_fn: (anchor: TemplateNode, component: C) => Dom | void
): void {
	var hydration_start_node: TemplateNode | undefined;

	if (hydrating) {
		hydration_start_node = hydrate_node;
		hydrate_next();
	}

	var branches = new BranchManager<C | null>(node);

	block(() => {
		var component = get_component() ?? null;

		if (hydrating) {
			var data = read_hydration_instruction(hydration_start_node as TemplateNode);

			var server_had_component = data === HYDRATION_START;
			var client_has_component = component !== null;

			if (server_had_component !== client_has_component) {
				// Hydration mismatch: skip the server-rendered nodes and render fresh
				var anchor = skip_nodes();

				set_hydrate_node(anchor);
				branches.anchor = anchor;

				set_hydrating(false);
				branches.ensure(component, component && ((target) => render_fn(target, component)));
				set_hydrating(true);

				return;
			}
		}

		branches.ensure(component, component && ((target) => render_fn(target, component)));
	}, EFFECT_TRANSPARENT);
}
