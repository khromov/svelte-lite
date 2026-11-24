/**
 * The deprecated API of Svelte that svelte-lite leaves out. Svelte still has all of it, so
 * whatever compares svelte-lite with Svelte (the entry points in `harness.test.ts`, the type
 * tests in `scripts/test-types.ts`) has to know what is missing on purpose.
 */
export interface RemovedExports {
	/** What is left out, as the type tests report it */
	feature: string;
	/** The entry point, as it is imported (`svelte`, `svelte/motion`) */
	module: string;
	/** The names it no longer exports, values and types, or `*` for the whole entry point */
	names: '*' | string[];
}

export const REMOVED_EXPORTS: RemovedExports[] = [
	{
		feature: '`beforeUpdate` and `afterUpdate`',
		module: 'svelte',
		names: ['beforeUpdate', 'afterUpdate']
	},
	{
		feature: 'the `spring` and `tweened` stores',
		module: 'svelte/motion',
		names: ['spring', 'tweened', 'Tweened', 'Updater']
	}
];

export interface RemovedOption {
	feature: string;
	module: string;
	/** The functions of `module` that no longer take the option */
	functions: string[];
	option: string;
}

export const REMOVED_OPTIONS: RemovedOption[] = [
	{
		feature: 'the `events` option of `mount` and `hydrate`',
		module: 'svelte',
		functions: ['mount', 'hydrate'],
		option: 'events'
	}
];

/** The names that `module` no longer exports, or `*` if the entry point is gone */
export function removed_from(module: string): '*' | Set<string> {
	const names = new Set<string>();

	for (const removed of REMOVED_EXPORTS) {
		if (removed.module !== module) continue;
		if (removed.names === '*') return '*';
		for (const name of removed.names) names.add(name);
	}

	return names;
}
