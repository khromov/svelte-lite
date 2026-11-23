import { STATE_SYMBOL } from '../constants.ts';
import { sanitize_location } from '../../../utils.ts';
import { untrack } from '../runtime.ts';
import * as w from '../warnings.ts';

function compare(a: any, b: any, property: string, location: string): any {
	if (a !== b && typeof b === 'object' && STATE_SYMBOL in b) {
		w.assignment_value_stale(property, sanitize_location(location));
	}

	return a;
}

export function assign(
	object: any,
	property: string,
	operator: string,
	rhs: any,
	location: string
): any {
	return compare(
		operator === '='
			? (object[property] = rhs)
			: operator === '&&='
				? (object[property] &&= rhs())
				: operator === '||='
					? (object[property] ||= rhs())
					: operator === '??='
						? (object[property] ??= rhs())
						: null,
		untrack(() => object[property]),
		property,
		location
	);
}

/**
 * What the compiler uses in place of `assign` when the right-hand side of a logical
 * assignment contains an `await`. That is any `async` function in a component,
 * and has nothing to do with `experimental.async`
 */
export async function assign_async(
	object: any,
	property: string,
	operator: string,
	rhs: any,
	location: string
): Promise<any> {
	return compare(
		operator === '='
			? (object[property] = await rhs)
			: operator === '&&='
				? (object[property] &&= await rhs())
				: operator === '||='
					? (object[property] ||= await rhs())
					: operator === '??='
						? (object[property] ??= await rhs())
						: null,
		untrack(() => object[property]),
		property,
		location
	);
}
