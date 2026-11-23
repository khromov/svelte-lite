import type { Effect } from '../../types.ts';
import { branch, destroy_effect, effect, managed } from '../../reactivity/effects.ts';

type Attachment = (node: Element) => void | (() => void);

// Svelte has the managed/branch structure for the sake of legacy mode, and plans to let a
// plain effect do the work once that is gone (https://github.com/sveltejs/svelte/pull/15962).
// Doing so here changes when an attachment re-runs, so it is a trim to measure, not part
// of taking the module over.

export function attach(node: Element, get_fn: () => Attachment | false | undefined | null): void {
	var fn: Attachment | false | undefined | null = undefined;
	var e: Effect | null = null;

	managed(() => {
		if (fn !== (fn = get_fn())) {
			if (e) {
				destroy_effect(e);
				e = null;
			}

			if (fn) {
				e = branch(() => {
					effect(() => (fn as Attachment)(node));
				});
			}
		}
	});
}
