import type { TemplateNode } from '../../types.ts';
import { block } from '../../reactivity/effects.ts';
import { hydrate_next, hydrating } from '../hydration.ts';
import { BranchManager } from './branches.ts';

const NAN = Symbol('NaN');

export function key<V>(
	node: TemplateNode,
	get_key: () => V,
	render_fn: (anchor: Node) => TemplateNode | void
): void {
	if (hydrating) {
		hydrate_next();
	}

	var branches = new BranchManager<V | typeof NAN>(node);

	block(() => {
		var key: V | typeof NAN = get_key();

		// NaN !== NaN, hence we do this workaround to not trigger remounts unnecessarily
		if (key !== key) {
			key = NAN;
		}

		branches.ensure(key, render_fn);
	});
}
