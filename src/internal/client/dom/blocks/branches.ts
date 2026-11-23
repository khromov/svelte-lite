import type { Effect, TemplateNode } from '../../types.ts';
import { branch, destroy_effect, pause_effect, resume_effect } from '../../reactivity/effects.ts';
import { hydrate_node, hydrating } from '../hydration.ts';

/**
 * Keeps the branches of a block (`{#if}`, `{#key}`, `{#await}`, `{@render}`, `<svelte:component>`,
 * `<svelte:element>`) by key, and shows the one that was selected last. A selection applies right
 * away: the new branch is rendered in front of the anchor, and the others transition out.
 */
export class BranchManager<Key> {
	anchor: TemplateNode;

	/**
	 * The branches that are in the DOM. For
	 * ```
	 * {#if condition}foo{:else}bar{/if}
	 * ```
	 * this can hold a branch for each of the two keys, while one of them is outroing
	 */
	#branches = new Map<Key, Effect>();

	/** Keys of the branches that are currently outroing */
	#outroing = new Set<Key>();

	/**
	 * Whether to pause (i.e. outro) on change, or destroy immediately.
	 * This is necessary for `<svelte:element>`
	 */
	#transition: boolean;

	constructor(anchor: TemplateNode, transition = true) {
		this.anchor = anchor;
		this.#transition = transition;
	}

	ensure(key: Key, fn: null | ((target: TemplateNode) => void)) {
		var branches = this.#branches;
		var outroing = this.#outroing;

		if (fn && !branches.has(key)) {
			branches.set(
				key,
				branch(() => fn(this.anchor))
			);
		}

		if (hydrating) {
			this.anchor = hydrate_node;
		}

		var selected = branches.get(key);

		if (selected) {
			// abort any current outro
			resume_effect(selected);
			outroing.delete(key);
		}

		// outro/destroy all other branches...
		for (const [k, effect] of branches) {
			// ...except those that are already outroing (else the transition is aborted and the effect destroyed right away)
			if (k === key || outroing.has(k)) continue;

			const on_destroy = () => {
				destroy_effect(effect);
				outroing.delete(k);
				branches.delete(k);
			};

			if (this.#transition || !selected) {
				outroing.add(k);
				pause_effect(effect, on_destroy, false);
			} else {
				on_destroy();
			}
		}
	}
}
