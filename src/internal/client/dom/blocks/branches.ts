import type { Effect, TemplateNode } from '../../types.ts';
import type { Batch } from '../../reactivity/batch.ts';
import { DEV } from 'esm-env';
import { EFFECT_OFFSCREEN, HMR_ANCHOR } from '../../constants.ts';
import { current_batch } from '../../reactivity/batch.ts';
import {
	branch,
	destroy_effect,
	move_effect,
	pause_effect,
	resume_effect
} from '../../reactivity/effects.ts';
import { hydrate_node, hydrating } from '../hydration.ts';
import { create_fragment, create_text, should_defer_append } from '../operations.ts';

type Branch = { effect: Effect; fragment: DocumentFragment };

/**
 * Keeps the branches of a block (`{#if}`, `{#key}`, `{#await}`, `{@render}`, `<svelte:component>`,
 * `<svelte:element>`) by key, and shows the one that was selected last.
 *
 * A selection normally applies right away. The exception is a block that re-runs while effects
 * are being flushed, because one of them wrote to state: the scheduler then wants the DOM to
 * change when the batch with that write commits (see `should_defer_append`). Until then the new
 * branch is rendered into a fragment, and the selection is kept with the batch that made it.
 */
export class BranchManager<Key> {
	anchor: TemplateNode;

	/** The key each batch selected, until the batch commits or is discarded */
	#batches = new Map<Batch, Key>();

	/**
	 * The branches that are in the DOM. For
	 * ```
	 * {#if condition}foo{:else}bar{/if}
	 * ```
	 * this can hold a branch for each of the two keys, while one of them is outroing
	 */
	#onscreen = new Map<Key, Effect>();

	/** The branches that are not in the DOM yet, because their insertion is deferred */
	#offscreen = new Map<Key, Branch>();

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

	#commit = (batch: Batch) => {
		// if this batch was made obsolete, bail
		if (!this.#batches.has(batch)) return;

		var key = this.#batches.get(batch) as Key;

		var onscreen = this.#onscreen.get(key);

		if (onscreen) {
			// effect is already in the DOM — abort any current outro
			resume_effect(onscreen);
			this.#outroing.delete(key);
		} else {
			// effect is currently offscreen. put it in the DOM
			var offscreen = this.#offscreen.get(key);

			if (offscreen) {
				// effect could have been outro'ed before through a prior batch — resume if necessary
				resume_effect(offscreen.effect);
				this.#onscreen.set(key, offscreen.effect);
				this.#offscreen.delete(key);

				var target = offscreen.fragment.lastChild as ChildNode;

				if (DEV) {
					// Tell hmr.js about the anchor it should use for updates,
					// since the initial one will be removed
					(target as any)[HMR_ANCHOR] = this.anchor;
				}

				// remove the anchor...
				target.remove();

				// ...and append the fragment
				this.anchor.before(offscreen.fragment);
				onscreen = offscreen.effect;
				onscreen.f &= ~EFFECT_OFFSCREEN;
			}
		}

		// other batches can still commit (in any order), so their selections remain
		this.#discard(batch);

		// outro/destroy all onscreen effects...
		for (const [k, effect] of this.#onscreen) {
			// ...except the one that was just committed
			//    or those that are already outroing (else the transition is aborted and the effect destroyed right away)
			if (k === key || this.#outroing.has(k)) continue;

			const on_destroy = () => {
				const keys = Array.from(this.#batches.values());

				if (keys.includes(k)) {
					// keep the effect offscreen, as another batch will need it
					var fragment = create_fragment();
					move_effect(effect, fragment);

					fragment.append(create_text()); // TODO can we avoid this?

					this.#offscreen.set(k, { effect, fragment });
				} else {
					destroy_effect(effect);
				}

				this.#outroing.delete(k);
				this.#onscreen.delete(k);
			};

			if (this.#transition || !onscreen) {
				this.#outroing.add(k);
				pause_effect(effect, on_destroy, false);
			} else {
				on_destroy();
			}
		}
	};

	#discard = (batch: Batch) => {
		for (const b of this.#batches.keys()) {
			// (batches that were merged into another one don't select anything anymore)
			if (b === batch || !b.linked) this.#batches.delete(b);
		}

		const keys = Array.from(this.#batches.values());

		for (const [k, branch] of this.#offscreen) {
			if (!keys.includes(k)) {
				destroy_effect(branch.effect);
				this.#offscreen.delete(k);
			}
		}
	};

	ensure(key: Key, fn: null | ((target: TemplateNode) => void)) {
		var batch = current_batch as Batch;
		var defer = should_defer_append();

		if (fn && !this.#onscreen.has(key) && !this.#offscreen.has(key)) {
			if (defer) {
				var fragment = create_fragment();
				var target = create_text();

				fragment.append(target);

				var effect = branch(() => fn(target));

				// until it is committed, the branch only exists for the batches that select it
				effect.f |= EFFECT_OFFSCREEN;
				batch.unskip_new_effect(effect);

				this.#offscreen.set(key, { effect, fragment });
			} else {
				this.#onscreen.set(
					key,
					branch(() => fn(this.anchor))
				);
			}
		}

		this.#batches.set(batch, key);

		if (defer) {
			for (const [k, effect] of this.#onscreen) {
				if (k === key) {
					batch.unskip_effect(effect);
				} else {
					batch.skip_effect(effect);
				}
			}

			for (const [k, branch] of this.#offscreen) {
				if (k === key) {
					batch.unskip_effect(branch.effect);
				} else {
					batch.skip_effect(branch.effect);
				}
			}

			batch.oncommit(this.#commit);
			batch.ondiscard(this.#discard);
		} else {
			if (hydrating) {
				this.anchor = hydrate_node;
			}

			this.#commit(batch);
		}
	}
}
