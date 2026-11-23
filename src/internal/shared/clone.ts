import type { Snapshot } from './types.ts';
import { DEV } from 'esm-env';
import * as w from './warnings.ts';
import { get_prototype_of, is_array, object_prototype } from './utils.ts';

/**
 * In dev, we keep track of which properties could not be cloned. In prod
 * we don't bother, but we keep a dummy array around so that the
 * signature stays the same
 */
const empty: string[] = [];

export function snapshot<T>(value: T, skip_warning = false, no_tojson = false): Snapshot<T> {
	if (DEV && !skip_warning) {
		const paths: string[] = [];

		const copy = clone(value, new Map(), '', paths, null, no_tojson);
		if (paths.length === 1 && paths[0] === '') {
			// value could not be cloned
			w.state_snapshot_uncloneable();
		} else if (paths.length > 0) {
			// some properties could not be cloned
			const slice = paths.length > 10 ? paths.slice(0, 7) : paths.slice(0, 10);
			const excess = paths.length - slice.length;

			let uncloned = slice.map((path) => `- <value>${path}`).join('\n');
			if (excess > 0) uncloned += `\n- ...and ${excess} more`;

			w.state_snapshot_uncloneable(uncloned);
		}

		return copy;
	}

	return clone(value, new Map(), '', empty, null, no_tojson);
}

/**
 * @param cloned What has been cloned so far, by the value it was cloned from
 * @param original The original value, if `value` was produced from a `toJSON` call
 */
function clone<T>(
	value: T,
	cloned: Map<unknown, unknown>,
	path: string,
	paths: string[],
	original: unknown = null,
	no_tojson = false
): Snapshot<T> {
	if (typeof value === 'object' && value !== null) {
		var unwrapped = cloned.get(value);
		if (unwrapped !== undefined) return unwrapped as Snapshot<T>;

		if (value instanceof Map) return new Map(value) as Snapshot<T>;
		if (value instanceof Set) return new Set(value) as Snapshot<T>;

		if (is_array(value)) {
			var copy: any = Array(value.length);
			cloned.set(value, copy);

			if (original !== null) {
				cloned.set(original, copy);
			}

			for (var i = 0; i < value.length; i += 1) {
				var element = value[i];
				if (i in value) {
					copy[i] = clone(element, cloned, DEV ? `${path}[${i}]` : path, paths, null, no_tojson);
				}
			}

			return copy;
		}

		if (get_prototype_of(value) === object_prototype) {
			copy = {};
			cloned.set(value, copy);

			if (original !== null) {
				cloned.set(original, copy);
			}

			for (var key of Object.keys(value)) {
				copy[key] = clone(
					(value as Record<string, unknown>)[key],
					cloned,
					DEV ? `${path}.${key}` : path,
					paths,
					null,
					no_tojson
				);
			}

			return copy;
		}

		if (value instanceof Date) {
			// Ensure SvelteDate snapshots are tracked
			value.getTime();
			return structuredClone(value) as Snapshot<T>;
		}

		if (typeof (value as T & { toJSON?: any }).toJSON === 'function' && !no_tojson) {
			return clone(
				(value as T & { toJSON(): any }).toJSON(),
				cloned,
				DEV ? `${path}.toJSON()` : path,
				paths,
				// Associate the instance with the toJSON clone
				value
			);
		}
	}

	if (value instanceof EventTarget) {
		// can't be cloned
		return value as Snapshot<T>;
	}

	try {
		return structuredClone(value) as Snapshot<T>;
	} catch (e) {
		if (DEV) {
			paths.push(path);
		}

		return value as Snapshot<T>;
	}
}
