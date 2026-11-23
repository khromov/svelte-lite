// The warnings that the client and the server runtime have in common. Svelte generates this
// module from `messages/shared-warnings` with `scripts/process-messages`. This is that output
// with types added, and it has to stay that: tests compare the texts, and the links lead to
// Svelte's documentation of each code.

import { DEV } from 'esm-env';

var bold = 'font-weight: bold';
var normal = 'font-weight: normal';

/**
 * `<svelte:element this="%tag%">` is a void element — it cannot have content
 */
export function dynamic_void_element_content(tag: string) {
	if (DEV) {
		console.warn(`%c[svelte] dynamic_void_element_content\n%c\`<svelte:element this="${tag}">\` is a void element — it cannot have content\nhttps://svelte.dev/e/dynamic_void_element_content`, bold, normal);
	} else {
		console.warn(`https://svelte.dev/e/dynamic_void_element_content`);
	}
}

/**
 * The following properties cannot be cloned with `$state.snapshot` — the return value contains the originals:
 *
 * %properties%
 */
export function state_snapshot_uncloneable(properties?: string | null) {
	if (DEV) {
		console.warn(
			`%c[svelte] state_snapshot_uncloneable\n%c${properties
				? `The following properties cannot be cloned with \`$state.snapshot\` — the return value contains the originals:

${properties}`
				: 'Value cannot be cloned with `$state.snapshot` — the original value was returned'}\nhttps://svelte.dev/e/state_snapshot_uncloneable`,
			bold,
			normal
		);
	} else {
		console.warn(`https://svelte.dev/e/state_snapshot_uncloneable`);
	}
}
