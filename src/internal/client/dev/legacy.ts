// Despite its name, this is not about legacy mode. In dev mode the compiler makes components
// call these, runes components included, so that using one the way a Svelte 4 component
// was used (`new Component(...)`, `component.$set(...)`) fails with an error that says so.

import * as e from '../errors.ts';
import { component_context } from '../context.ts';
import { FILENAME } from '../../../constants.ts';

export function check_target(target: (Function & { [FILENAME]: string }) | undefined): void {
	if (target) {
		e.component_api_invalid_new(target[FILENAME] ?? 'a component', target.name);
	}
}

export function legacy_api() {
	const component = component_context?.function;

	function error(method: string): never {
		e.component_api_changed(method, component[FILENAME]);
	}

	return {
		$destroy: () => error('$destroy()'),
		$on: () => error('$on(...)'),
		$set: () => error('$set(...)')
	};
}
