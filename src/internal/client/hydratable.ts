import { unsupported } from '../../unsupported.ts';

/**
 * `hydratable` needs `experimental.async`, which svelte-lite leaves out in the browser.
 * It is part of the public API of `svelte`, so the export stays
 */
export function hydratable<T>(key: string, fn: () => T): T {
	unsupported('`hydratable`, which needs `experimental.async`');
}
