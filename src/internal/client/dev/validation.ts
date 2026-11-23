import * as e from '../errors.ts';

export function validate_snippet_args(anchor: Node, ...args: (() => any)[]): void {
	if (typeof anchor !== 'object' || !(anchor instanceof Node)) {
		e.invalid_snippet_arguments();
	}

	for (let arg of args) {
		if (typeof arg !== 'function') {
			e.invalid_snippet_arguments();
		}
	}
}
