import type { Value } from './types.ts';

/**
 * In Svelte, the signals read while `invalidate_inner_signals` runs. Only a legacy mode
 * component is compiled to a call of that, so svelte-lite has no such function and this
 * stays `null`. The name is kept for `get()` in the runtime module, which still reads it:
 * once nothing imports this module any more, it can be removed.
 */
export const captured_signals: Set<Value> | null = null;
