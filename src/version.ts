// Svelte generates its module during a release. This one names the version of Svelte whose
// compiler output svelte-lite runs, which is the one in vendor/svelte, and has to follow it
// when that moves.

/**
 * The version of Svelte that this is a runtime for, as set in its package.json.
 */
export const VERSION: string = '5.59.1';
export const PUBLIC_VERSION = '5';
