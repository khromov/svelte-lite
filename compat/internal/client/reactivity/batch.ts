// Stands in for upstream src/internal/client/reactivity/batch.js
export * from '../../../../src/internal/client/reactivity/batch.ts';

/**
 * Svelte links its batches in a list, which a test for `fork` walks. svelte-lite's scheduler has
 * no batches (and no `fork`), so the list is always empty
 */
export const first_batch = null;
