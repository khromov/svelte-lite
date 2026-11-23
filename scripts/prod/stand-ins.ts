/**
 * What the `_config.js` of a sample imports from the suite around it, for the bundle of that
 * sample. The modules of the suite themselves (`runtime-runes/test.ts`, `helpers.js`,
 * `suite.ts`) set up vitest and read the file system when they load, so they stay out of a
 * bundle for the browser. A sample that imports a name which is missing here fails to build.
 */

export const test = <T>(config: T) => config;

export function ok(value: unknown): asserts value {
	if (!value) {
		throw new Error(`Expected truthy value, got ${value}`);
	}
}

export { ok as assert_ok };

/** The suite runs with `SVELTE_NO_ASYNC`, see vitest.config.ts */
export const async_mode = false;
