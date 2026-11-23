/** Fails loudly when something reaches for a feature that svelte-lite leaves out */
export function unsupported(feature: string): never {
	throw new Error(`svelte-lite does not support ${feature}`);
}
