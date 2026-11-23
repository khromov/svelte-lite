import { unsupported } from '../../../../../unsupported.ts';

/**
 * Makes an `export`ed (non-prop) variable available on the `$$props` object so that
 * consumers can do `bind:x` on the component. Only a legacy mode component is compiled
 * to a call of this, so nothing is behind it. The name stays for as long as
 * `internal/client/index` re-exports it.
 */
export function bind_prop(props: Record<string, unknown>, prop: string, value: unknown): void {
	unsupported('legacy mode: components have to use runes');
}
