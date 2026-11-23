import { STATE_SYMBOL } from '../constants.ts';
import { snapshot } from '../../shared/clone.ts';
import * as w from '../warnings.ts';
import { untrack } from '../runtime.ts';

export function log_if_contains_state(method: string, ...objects: any[]): any[] {
	untrack(() => {
		try {
			let has_state = false;
			const transformed = [];

			for (const obj of objects) {
				if (obj && typeof obj === 'object' && STATE_SYMBOL in obj) {
					transformed.push(snapshot(obj, true));
					has_state = true;
				} else {
					transformed.push(obj);
				}
			}

			if (has_state) {
				w.console_log_state(method);

				// eslint-disable-next-line no-console
				console.log('%c[snapshot]', 'color: grey', ...transformed);
			}
		} catch {
			// Errors can occur when trying to snapshot objects with getters that throw or non-enumerable properties.
		}
	});

	return objects;
}
