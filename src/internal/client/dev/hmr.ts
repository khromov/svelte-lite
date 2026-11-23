import type { Effect, Source, TemplateNode } from '../types.ts';
import { FILENAME, HMR } from '../../../constants.ts';
import { EFFECT_TRANSPARENT, HMR_ANCHOR } from '../constants.ts';
import { hydrate_node, hydrating } from '../dom/hydration.ts';
import { block, branch, destroy_effect } from '../reactivity/effects.ts';
import { set, source } from '../reactivity/sources.ts';
import { set_should_intro } from '../render.ts';
import { active_effect, get } from '../runtime.ts';

/** A component as `hmr` returns it, which is what the `accept` handler in compiled output works with */
type Wrapped<T = Function> = T & {
	[FILENAME]: string;
	[HMR]: {
		fn: Function;
		current: Source<any>;
		update: (incoming: Wrapped) => void;
	};
};

export function hmr<Component extends (anchor: Comment, props: any) => any>(fn: Component) {
	const current = source(fn);

	function wrapper(initial_anchor: TemplateNode, props: any) {
		let component: any = {};
		let instance: Record<string, any> = {};

		let effect: Effect;

		let ran = false;
		let anchor = initial_anchor;

		block(() => {
			if (component === (component = get(current))) {
				return;
			}

			if (effect) {
				for (var k in instance) delete instance[k];
				destroy_effect(effect);
			}

			effect = branch(() => {
				anchor = (anchor as any)[HMR_ANCHOR] ?? anchor;

				// when the component is invalidated, replace it without transitions
				if (ran) set_should_intro(false);

				// preserve getters/setters
				var result = new.target ? new component(anchor, props) : component(anchor, props);
				// a component is not guaranteed to return something and we can't invoke getOwnPropertyDescriptors on undefined
				if (result) {
					Object.defineProperties(instance, Object.getOwnPropertyDescriptors(result));
				}

				if (ran) set_should_intro(true);
			});

			// Forward the start/end DOM nodes from the inner effect to the outer active effect
			// which would get them if the HMR wrapper wasn't there. Do this inside the block not
			// outside so that HMR updates to the component will also update the nodes on the
			// active effect. We copy only start/end, not the full nodes object, so that
			// pause_children does not collect transitions from both effects and fire outroend twice.
			var inner_nodes = effect.nodes;
			if (inner_nodes) {
				var ae = active_effect as Effect;
				if (ae.nodes) {
					ae.nodes.start = inner_nodes.start;
					ae.nodes.end = inner_nodes.end;
				} else {
					ae.nodes = { start: inner_nodes.start, end: inner_nodes.end, a: null, t: null };
				}
			}
		}, EFFECT_TRANSPARENT);

		ran = true;

		if (hydrating) {
			anchor = hydrate_node;
		}

		return instance;
	}

	// the same function, seen with the properties it gets here
	const wrapped = wrapper as Wrapped<typeof wrapper>;

	wrapped[FILENAME] = (fn as Wrapped<Component>)[FILENAME];

	wrapped[HMR] = {
		fn,
		current,
		update: (incoming) => {
			// This logic ensures that the first version of the component is the one
			// whose update function and therefore block effect is preserved across updates.
			// If we don't do this dance and instead just use `incoming` as the new component
			// and then update, we'll create an ever-growing stack of block effects.

			// Trigger the original block effect
			set(wrapped[HMR].current, incoming[HMR].fn);

			// Replace the incoming source with the original one
			incoming[HMR].current = wrapped[HMR].current;
		}
	};

	return wrapper;
}
