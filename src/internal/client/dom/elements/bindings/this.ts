import type { ComponentContext, Effect } from '../../../types.ts';
import { DESTROYING, STATE_SYMBOL } from '../../../constants.ts';
import { component_context, mark_as_component } from '../../../context.ts';
import { effect, render_effect } from '../../../reactivity/effects.ts';
import { active_effect, untrack } from '../../../runtime.ts';

function is_bound_this(bound_value: any, element_or_component: Element): boolean {
	return (
		bound_value === element_or_component || bound_value?.[STATE_SYMBOL] === element_or_component
	);
}

/**
 * @param get_parts Set if the this binding is used inside an each block,
 * 					returns all the parts of the each block context that are used in the expression
 */
export function bind_this(
	element_or_component: any = mark_as_component(),
	update: (value: unknown, ...parts: unknown[]) => void,
	get_value: (...parts: unknown[]) => unknown,
	get_parts?: () => unknown[]
): any {
	var component_effect = (component_context as ComponentContext).r;
	var parent = active_effect as Effect;

	effect(() => {
		var old_parts: unknown[];
		var parts: unknown[];

		render_effect(() => {
			old_parts = parts;
			// We only track changes to the parts, not the value itself to avoid unnecessary reruns.
			parts = get_parts?.() || [];

			untrack(() => {
				if (!is_bound_this(get_value(...parts), element_or_component)) {
					update(element_or_component, ...parts);
					// If this is an effect rerun (cause: each block context changes), then nullify the binding at
					// the previous position if it isn't already taken over by a different effect.
					if (old_parts && is_bound_this(get_value(...old_parts), element_or_component)) {
						update(null, ...old_parts);
					}
				}
			});
		});

		return () => {
			// When the bind:this effect is destroyed, we go up the effect parent chain until we find the last parent effect that is destroyed,
			// or the effect containing the component bind:this is in (whichever comes first). That way we can time the nulling of the binding
			// as close to user/developer expectation as possible.
			// TODO Svelte 6: Decide if we want to keep this logic or just always null the binding in the component effect's teardown
			// (which would be simpler, but less intuitive in some cases, and breaks the `ondestroy-before-cleanup` test)
			let p = parent;
			while (p !== component_effect && p.parent !== null && p.parent.f & DESTROYING) {
				p = p.parent;
			}
			const teardown = () => {
				if (parts && is_bound_this(get_value(...parts), element_or_component)) {
					update(null, ...parts);
				}
			};
			const original_teardown = p.teardown;
			p.teardown = () => {
				teardown();
				original_teardown?.();
			};
		};
	});

	return element_or_component;
}
