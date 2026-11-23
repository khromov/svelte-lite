import { PUBLIC_VERSION } from '../version.ts';

if (typeof window !== 'undefined') {
	// @ts-expect-error
	((globalThis.__svelte ??= {}).v ??= new Set()).add(PUBLIC_VERSION);
}
