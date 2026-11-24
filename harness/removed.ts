/**
 * The deprecated API of Svelte that svelte-lite leaves out. Svelte still has all of it, so
 * whatever compares svelte-lite with Svelte (the entry points in `harness.test.ts`, the type
 * tests in `scripts/test-types.ts`, the resolution of imports in `resolve.ts`) has to know
 * what is missing on purpose.
 */
import path from 'node:path';
import { ROOT, UPSTREAM_TESTS } from './paths.ts';

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
	},
	{
		feature: '`svelte/legacy`',
		module: 'svelte/legacy',
		names: '*'
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

/**
 * Stand-ins for removed entry points, for the drivers of the suite that use one only to mount
 * the components of their samples (see `harness/support/`). Only the files listed here get
 * one. A sample, or any other file, that imports the entry point fails, as it should.
 */
export const STAND_INS: Record<string, { file: string; drivers: string[] }> = {
	'svelte/legacy': {
		file: path.join(ROOT, 'harness/support/legacy.ts'),
		drivers: ['runtime-browser/driver.js', 'hydration/test.ts', 'runtime-legacy/shared.ts'].map(
			(file) => path.join(UPSTREAM_TESTS, file)
		)
	}
};

/** The stand-in that `importer` gets for `specifier`, if it is one of the drivers that get one */
export function stand_in(specifier: string, importer: string | undefined): string | null {
	const entry = STAND_INS[specifier];
	return entry && importer && entry.drivers.includes(importer) ? entry.file : null;
}

/** The error for an import of an entry point that svelte-lite removed, if it is one */
export function removed_entry_point(specifier: string): string | null {
	const removed = REMOVED_EXPORTS.find((r) => r.module === specifier && r.names === '*');
	return removed
		? `svelte-lite removed ${specifier}, which Svelte deprecates. README.md says what to use instead`
		: null;
}

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
