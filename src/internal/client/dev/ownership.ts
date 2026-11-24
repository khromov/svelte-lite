import { get_descriptor } from '../../shared/utils.ts';
import { LEGACY_PROPS, STATE_SYMBOL } from '../constants.ts';
import { FILENAME } from '../../../constants.ts';
import { component_context } from '../context.ts';
import * as w from '../warnings.ts';
import { sanitize_location } from '../../../utils.ts';

/**
 * Sets up a validator that
 * - traverses the path of a prop to find out if it is allowed to be mutated
 * - checks that the binding chain is not interrupted
 */
export function create_ownership_validator(props: Record<string, any>) {
	const component = component_context?.function;
	const parent = component_context?.p?.function;

	return {
		mutation: (prop: string, path: any[], result: any, line: number, column: number): any => {
			const name = path[0];
			if (is_bound_or_unset(props, name) || !parent) {
				return result;
			}

			let value: any = props;

			for (let i = 0; i < path.length - 1; i++) {
				value = value[path[i]];
				if (!value?.[STATE_SYMBOL]) {
					return result;
				}
			}

			const location = sanitize_location(`${component[FILENAME]}:${line}:${column}`);

			w.ownership_invalid_mutation(name, location, prop, parent[FILENAME]);

			return result;
		},
		binding: (key: any, child_component: any, value: () => any): void => {
			if (!is_bound_or_unset(props, key) && parent && value()?.[STATE_SYMBOL]) {
				w.ownership_invalid_binding(
					component[FILENAME],
					key,
					child_component[FILENAME],
					parent[FILENAME]
				);
			}
		}
	};
}

function is_bound_or_unset(props: Record<string, any>, prop_name: string): boolean {
	// Can be the case when someone does `mount(Component, props)` with `let props = $state({...})`,
	// and for the component of a custom element, whose props are marked with `LEGACY_PROPS`
	const is_entry_props = STATE_SYMBOL in props || LEGACY_PROPS in props;
	return (
		!!get_descriptor(props, prop_name)?.set ||
		(is_entry_props && prop_name in props) ||
		!(prop_name in props)
	);
}
