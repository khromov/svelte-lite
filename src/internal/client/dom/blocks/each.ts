import type {
	EachItem,
	EachOutroGroup,
	EachState,
	Effect,
	EffectNodes,
	MaybeSource,
	TemplateNode
} from '../../types.ts';
import type { Batch } from '../../reactivity/batch.ts';
import {
	EACH_INDEX_REACTIVE,
	EACH_IS_ANIMATED,
	EACH_IS_CONTROLLED,
	EACH_ITEM_IMMUTABLE,
	EACH_ITEM_REACTIVE,
	HYDRATION_END,
	HYDRATION_START_ELSE
} from '../../../../constants.ts';
import {
	hydrate_next,
	hydrate_node,
	hydrating,
	read_hydration_instruction,
	skip_nodes,
	set_hydrate_node,
	set_hydrating
} from '../hydration.ts';
import {
	clear_text_content,
	create_text,
	get_first_child,
	get_next_sibling,
	should_defer_append
} from '../operations.ts';
import {
	block,
	branch,
	destroy_effect,
	move_effect,
	pause_effect,
	resume_effect
} from '../../reactivity/effects.ts';
import { source, internal_set } from '../../reactivity/sources.ts';
import { safe_equals } from '../../reactivity/equality.ts';
import { array_from, is_array } from '../../../shared/utils.ts';
import {
	BRANCH_EFFECT,
	COMMENT_NODE,
	DESTROYED,
	EFFECT_OFFSCREEN,
	INERT
} from '../../constants.ts';
import { queue_micro_task } from '../task.ts';
import { get } from '../../runtime.ts';
import { DEV } from 'esm-env';
import { derived_safe_equal } from '../../reactivity/deriveds.ts';
import { current_batch } from '../../reactivity/batch.ts';
import * as e from '../../errors.ts';
import { tag } from '../../dev/tracing.ts';

// When making substantive changes to this file, validate them with the each block stress test:
// https://svelte.dev/playground/1972b2cf46564476ad8c8c6405b23b7b
// This test also exists in the Svelte repo, as `packages/svelte/tests/manual/each-stress-test`

export function index(_: any, i: number) {
	return i;
}

/**
 * Pause multiple effects simultaneously, and coordinate their
 * subsequent destruction. Used in each blocks
 */
function pause_effects(state: EachState, to_destroy: Effect[], controlled_anchor: null | Node) {
	var length = to_destroy.length;

	var group: EachOutroGroup | undefined;
	var remaining = to_destroy.length;

	for (var i = 0; i < length; i++) {
		let effect = to_destroy[i];

		pause_effect(
			effect,
			() => {
				if (group) {
					group.pending.delete(effect);
					group.done.add(effect);

					if (group.pending.size === 0) {
						var groups = state.outrogroups as Set<EachOutroGroup>;

						destroy_effects(state, array_from(group.done));
						groups.delete(group);

						if (groups.size === 0) {
							state.outrogroups = null;
						}
					}
				} else {
					remaining -= 1;
				}
			},
			false
		);
	}

	if (remaining === 0) {
		// If we're in a controlled each block (i.e. the block is the only child of an
		// element), and we are removing all items, _and_ there are no out transitions,
		// we can use the fast path — emptying the element and replacing the anchor.
		// Skip the fast path when another batch is still pending on this each block:
		// that batch's keys still reference EachItems in `state.items`, which
		// `destroy_effects` needs to preserve offscreen (see sveltejs/svelte#18610).
		var fast_path = controlled_anchor !== null && state.pending.size === 0;

		if (fast_path) {
			var anchor = controlled_anchor as Element;
			var parent_node = anchor.parentNode as Element;

			clear_text_content(parent_node);
			parent_node.append(anchor);

			state.items.clear();
		}

		destroy_effects(state, to_destroy, !fast_path);
	} else {
		group = {
			pending: new Set(to_destroy),
			done: new Set()
		};

		(state.outrogroups ??= new Set()).add(group);
	}
}

function selected_effects(state: EachState): Set<Effect> {
	var selected = new Set<Effect>();
	// The loop-in-a-loop isn't ideal, but we should only hit this in relatively rare cases
	for (const keys of state.pending.values()) {
		for (const key of keys) {
			selected.add((state.items.get(key) as EachItem).e);
		}
	}
	return selected;
}

function destroy_effects(state: EachState, to_destroy: Effect[], remove_dom = true) {
	var preserved_effects = state.pending.size > 0 ? selected_effects(state) : undefined;

	for (var i = 0; i < to_destroy.length; i++) {
		var e = to_destroy[i];

		if (preserved_effects?.has(e)) {
			e.f |= EFFECT_OFFSCREEN;

			const fragment = document.createDocumentFragment();
			move_effect(e, fragment);

			// `reconcile` expects offscreen items to come after all onscreen items
			if (e !== state.effect.last) {
				link(state, e.prev, e.next);
				link(state, state.effect.last, e);
				link(state, e, null);
			}
		} else {
			destroy_effect(to_destroy[i], remove_dom);
		}
	}
}

/**
 * Whether the item is outroing, i.e. `pause_effects` destroys it (or keeps it offscreen) once its outro is done
 */
function is_outroing(state: EachState, effect: Effect) {
	if (state.outrogroups !== null) {
		for (const group of state.outrogroups) {
			if (group.pending.has(effect) || group.done.has(effect)) return true;
		}
	}

	return false;
}

/** Where items that are created after the first run render to, until `reconcile` moves them into place */
var offscreen_anchor: Text | undefined;

/**
 * @param node The next sibling node, or the parent node if this is a 'controlled' block
 */
export function each<V>(
	node: Element | Comment,
	flags: number,
	get_collection: () => V[],
	get_key: (value: V, index: number) => any,
	render_fn: (
		anchor: Node,
		item: MaybeSource<V>,
		index: MaybeSource<number>,
		collection: () => V[]
	) => void,
	fallback_fn: null | ((anchor: Node) => void) = null
): void {
	var anchor: TemplateNode = node;

	var items = new Map<any, EachItem>();

	var is_controlled = (flags & EACH_IS_CONTROLLED) !== 0;

	if (is_controlled) {
		var parent_node = node as Element;

		anchor = hydrating
			? set_hydrate_node(get_first_child(parent_node))
			: parent_node.appendChild(create_text());
	}

	if (hydrating) {
		hydrate_next();
	}

	var fallback: Effect | null = null;

	// TODO: ideally we could use derived for runes mode but because of the ability
	// to use a store which can be mutated, we can't do that here as mutating a store
	// will still result in the collection array being the same from the store
	var each_array = derived_safe_equal(() => {
		var collection = get_collection();

		return (
			is_array(collection) ? collection : collection == null ? [] : array_from(collection)
		) as V[];
	});

	if (DEV) {
		tag(each_array, '{#each ...}');
	}

	var pending = new Map<Batch, Set<any>>();

	var first_run = true;

	function commit(batch: Batch) {
		if ((state.effect.f & DESTROYED) !== 0) {
			return;
		}

		state.pending.delete(batch);

		// The effect doesn't necessarily re-run in a batch right before that batch commits
		// (its view of the collection may not have changed), so we read the collection
		// as the committing batch sees it rather than using the most recent block run's result
		var array = get(each_array);

		state.fallback = fallback;
		reconcile(state, array, anchor, flags, get_key);

		if (fallback !== null) {
			if (array.length === 0) {
				if ((fallback.f & EFFECT_OFFSCREEN) === 0) {
					resume_effect(fallback);
				} else {
					fallback.f ^= EFFECT_OFFSCREEN;
					move(fallback, null, anchor);
				}
			} else {
				pause_effect(fallback, () => {
					// TODO only null out if no pending batch needs it,
					// otherwise re-add `fallback.fragment` and move the
					// effect into it
					fallback = null;
				});
			}
		}

		destroy_unselected();
	}

	function discard(batch: Batch) {
		state.pending.delete(batch);

		if ((state.effect.f & DESTROYED) === 0) {
			destroy_unselected();
		}
	}

	/**
	 * Destroys the offscreen items that no pending batch selects anymore. Offscreen items only exist
	 * for the batches that select them: they were created in their view, or kept for them when a
	 * commit removed them (see `destroy_effects`). A batch stops selecting an item when it's discarded,
	 * or when its block runs again without it. `reconcile` doesn't destroy such an item if it was kept,
	 * as kept items are paused, and it leaves paused items alone (taking them to be outroing)
	 */
	function destroy_unselected() {
		var selected: Set<Effect> | undefined;
		var effect = state.effect.last;

		// offscreen items come after all onscreen items (see `destroy_effects`)
		while (effect !== null) {
			var prev = effect.prev;

			// (an offscreen fallback isn't paused, so the next commit shows it or destroys it, see above)
			if ((effect.f & BRANCH_EFFECT) !== 0 && effect !== fallback) {
				if ((effect.f & EFFECT_OFFSCREEN) === 0) break;

				// create lazily to save work in the common case
				selected ??= selected_effects(state);

				if (!selected.has(effect) && !is_outroing(state, effect)) {
					destroy_effect(effect);
				}
			}

			effect = prev;
		}
	}

	var effect = block(() => {
		var array = get(each_array);
		var length = array.length;

		/** `true` if there was a hydration mismatch. Needs to be a `let` or else it isn't treeshaken out */
		let mismatch = false;

		if (hydrating) {
			var is_else = read_hydration_instruction(anchor) === HYDRATION_START_ELSE;

			if (is_else !== (length === 0)) {
				// hydration mismatch — remove the server-rendered DOM and start over
				anchor = skip_nodes();

				set_hydrate_node(anchor);
				set_hydrating(false);
				mismatch = true;
			}
		}

		var keys = new Set();
		var batch = current_batch as Batch;
		var defer = should_defer_append();

		for (var index = 0; index < length; index += 1) {
			if (
				hydrating &&
				hydrate_node.nodeType === COMMENT_NODE &&
				(hydrate_node as Comment).data === HYDRATION_END
			) {
				// The server rendered fewer items than expected,
				// so break out and continue appending non-hydrated items
				anchor = hydrate_node;
				mismatch = true;
				set_hydrating(false);
			}

			var value = array[index];
			var key = get_key(value, index);

			if (DEV) {
				// Check that the key function is idempotent (returns the same value when called twice)
				var key_again = get_key(value, index);
				if (key !== key_again) {
					e.each_key_volatile(String(index), String(key), String(key_again));
				}
			}

			var item = first_run ? null : items.get(key);

			if (item) {
				// update before reconciliation
				if (item.v) internal_set(item.v, value);
				if (item.i) internal_set(item.i, index);

				if (defer) {
					batch.unskip_effect(item.e);
				}
			} else {
				item = create_item(
					items,
					first_run ? anchor : (offscreen_anchor ??= create_text()),
					value,
					key,
					index,
					render_fn,
					flags,
					get_collection
				);

				if (!first_run) {
					// until it is committed, the item only exists for the batches that select it
					item.e.f |= EFFECT_OFFSCREEN;
					if (defer) batch.unskip_new_effect(item.e);
				}

				items.set(key, item);
			}

			keys.add(key);
		}

		if (length === 0 && fallback_fn && !fallback) {
			if (first_run) {
				fallback = branch(() => fallback_fn(anchor));
			} else {
				fallback = branch(() => fallback_fn((offscreen_anchor ??= create_text())));
				// until it is committed, the fallback only exists for the batches that select it
				fallback.f |= EFFECT_OFFSCREEN;
				if (defer) batch.unskip_new_effect(fallback);
			}
		}

		if (defer && fallback !== null) {
			if (length === 0) {
				batch.unskip_effect(fallback);
			} else {
				batch.skip_effect(fallback);
			}
		}

		if (length > keys.size) {
			if (DEV) {
				validate_each_keys(array, get_key);
			} else {
				// in prod, the additional information isn't printed, so don't bother computing it
				e.each_key_duplicate('', '', '');
			}
		}

		// remove excess nodes
		if (hydrating && length > 0) {
			set_hydrate_node(skip_nodes());
		}

		if (!first_run) {
			pending.set(batch, keys);

			if (defer) {
				for (const [key, item] of items) {
					if (!keys.has(key)) {
						batch.skip_effect(item.e);
					}
				}

				batch.oncommit(commit);
				batch.ondiscard(discard);
			} else {
				commit(batch);
			}
		}

		if (mismatch) {
			// continue in hydration mode
			set_hydrating(true);
		}

		// When we mount the each block for the first time, the collection won't be
		// connected to this effect as the effect hasn't finished running yet and its deps
		// won't be assigned. However, it's possible that when reconciling the each block
		// that a mutation occurred and it's made the collection MAYBE_DIRTY, so reading the
		// collection again can provide consistency to the reactive graph again as the deriveds
		// will now be `CLEAN`.
		get(each_array);
	});

	var state: EachState = { effect, flags, items, pending, outrogroups: null, fallback };

	first_run = false;

	if (hydrating) {
		anchor = hydrate_node;
	}
}

/**
 * Skip past any non-branch effects (which could be created with `createSubscriber`, for example) to find the next branch effect
 */
function skip_to_branch(effect: Effect | null): Effect | null {
	while (effect !== null && (effect.f & BRANCH_EFFECT) === 0) {
		effect = effect.next;
	}
	return effect;
}

/**
 * Add, remove, or reorder items output by an each block as its input changes
 */
function reconcile<V>(
	state: EachState,
	array: V[],
	anchor: TemplateNode,
	flags: number,
	get_key: (value: V, index: number) => any
): void {
	var is_animated = (flags & EACH_IS_ANIMATED) !== 0;

	var length = array.length;
	var items = state.items;
	var current = skip_to_branch(state.effect.first);

	var seen: undefined | Set<Effect>;

	var prev: Effect | null = null;

	var to_animate: undefined | Set<Effect>;

	var matched: Effect[] = [];

	var stashed: Effect[] = [];

	var value: V;

	var key: any;

	var effect: Effect;

	var i: number;

	if (is_animated) {
		for (i = 0; i < length; i += 1) {
			value = array[i];
			key = get_key(value, i);
			effect = (items.get(key) as EachItem).e;

			// offscreen == coming in now, no animation in that case,
			// else this would happen https://github.com/sveltejs/svelte/issues/17181
			if ((effect.f & EFFECT_OFFSCREEN) === 0) {
				effect.nodes?.a?.measure();
				(to_animate ??= new Set()).add(effect);
			}
		}
	}

	for (i = 0; i < length; i += 1) {
		value = array[i];
		key = get_key(value, i);

		effect = (items.get(key) as EachItem).e;

		if (state.outrogroups !== null) {
			for (const group of state.outrogroups) {
				group.pending.delete(effect);
				group.done.delete(effect);
			}
		}

		if ((effect.f & INERT) !== 0) {
			resume_effect(effect);
			if (is_animated) {
				effect.nodes?.a?.unfix();
				(to_animate ??= new Set()).delete(effect);
			}
		}

		if ((effect.f & EFFECT_OFFSCREEN) !== 0) {
			effect.f ^= EFFECT_OFFSCREEN;

			if (effect === current) {
				move(effect, null, anchor);
			} else {
				var next = prev ? prev.next : current;

				if (effect === state.effect.last) {
					state.effect.last = effect.prev;
				}

				if (effect.prev) effect.prev.next = effect.next;
				if (effect.next) effect.next.prev = effect.prev;
				link(state, prev, effect);
				link(state, effect, next);

				move(effect, next, anchor);
				prev = effect;

				matched = [];
				stashed = [];

				current = skip_to_branch(prev.next);
				continue;
			}
		}

		if (effect !== current) {
			if (seen !== undefined && seen.has(effect)) {
				if (matched.length < stashed.length) {
					// more efficient to move later items to the front
					var start = stashed[0];
					var j;

					prev = start.prev;

					var a = matched[0];
					var b = matched[matched.length - 1];

					for (j = 0; j < matched.length; j += 1) {
						move(matched[j], start, anchor);
					}

					for (j = 0; j < stashed.length; j += 1) {
						seen.delete(stashed[j]);
					}

					link(state, a.prev, b.next);
					link(state, prev, a);
					link(state, b, start);

					current = start;
					prev = b;
					i -= 1;

					matched = [];
					stashed = [];
				} else {
					// more efficient to move earlier items to the back
					seen.delete(effect);
					move(effect, current, anchor);

					link(state, effect.prev, effect.next);
					link(state, effect, prev === null ? state.effect.first : prev.next);
					link(state, prev, effect);

					prev = effect;
				}

				continue;
			}

			matched = [];
			stashed = [];

			while (current !== null && current !== effect) {
				(seen ??= new Set()).add(current);
				stashed.push(current);
				current = skip_to_branch(current.next);
			}

			if (current === null) {
				continue;
			}
		}

		if ((effect.f & EFFECT_OFFSCREEN) === 0) {
			matched.push(effect);
		}

		prev = effect;
		current = skip_to_branch(effect.next);
	}

	if (state.outrogroups !== null) {
		for (const group of state.outrogroups) {
			if (group.pending.size === 0) {
				destroy_effects(state, array_from(group.done));
				state.outrogroups?.delete(group);
			}
		}

		if (state.outrogroups.size === 0) {
			state.outrogroups = null;
		}
	}

	if (current !== null || seen !== undefined) {
		var to_destroy: Effect[] = [];

		if (seen !== undefined) {
			for (effect of seen) {
				if ((effect.f & INERT) === 0) {
					to_destroy.push(effect);
				}
			}
		}

		while (current !== null) {
			// If the each block isn't inert, then inert effects are currently outroing and will be removed once the transition is finished
			if ((current.f & INERT) === 0 && current !== state.fallback) {
				to_destroy.push(current);
			}

			current = skip_to_branch(current.next);
		}

		var destroy_length = to_destroy.length;

		if (destroy_length > 0) {
			var controlled_anchor = (flags & EACH_IS_CONTROLLED) !== 0 && length === 0 ? anchor : null;

			if (is_animated) {
				for (i = 0; i < destroy_length; i += 1) {
					to_destroy[i].nodes?.a?.measure();
				}

				for (i = 0; i < destroy_length; i += 1) {
					to_destroy[i].nodes?.a?.fix();
				}
			}

			pause_effects(state, to_destroy, controlled_anchor);
		}
	}

	if (is_animated) {
		queue_micro_task(() => {
			if (to_animate === undefined) return;
			for (effect of to_animate) {
				effect.nodes?.a?.apply();
			}
		});
	}
}

function create_item<V>(
	items: Map<any, EachItem>,
	anchor: Node,
	value: V,
	key: unknown,
	index: number,
	render_fn: (
		anchor: Node,
		item: MaybeSource<V>,
		index: MaybeSource<number>,
		collection: () => V[]
	) => void,
	flags: number,
	get_collection: () => V[]
): EachItem {
	var v = (flags & EACH_ITEM_REACTIVE) !== 0 ? source(value) : null;

	// The compiler leaves `EACH_ITEM_IMMUTABLE` out for `{#each $store}`, whose items can be mutated
	// in place. Such an item is updated even if it's the same object as before
	if (v !== null && (flags & EACH_ITEM_IMMUTABLE) === 0) {
		v.equals = safe_equals;
	}

	var i = (flags & EACH_INDEX_REACTIVE) !== 0 ? source(index) : null;

	if (DEV && v) {
		// For tracing purposes, we need to link the source signal we create with the
		// collection + index so that tracing works as intended
		v.trace = () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-expressions
			get_collection()[i?.v ?? index];
		};
	}

	return {
		v,
		i,
		e: branch(() => {
			render_fn(anchor, v ?? value, i ?? index, get_collection);

			return () => {
				items.delete(key);
			};
		})
	};
}

function move(effect: Effect, next: Effect | null, anchor: TemplateNode) {
	if (!effect.nodes) return;

	var node: TemplateNode | null = effect.nodes.start;
	var end = effect.nodes.end;

	var dest =
		next && (next.f & EFFECT_OFFSCREEN) === 0 ? (next.nodes as EffectNodes).start : anchor;

	while (node !== null) {
		var next_node = get_next_sibling(node) as TemplateNode;
		dest.before(node);

		if (node === end) {
			return;
		}

		node = next_node;
	}
}

function link(state: EachState, prev: Effect | null, next: Effect | null) {
	if (prev === null) {
		state.effect.first = next;
	} else {
		prev.next = next;
	}

	if (next === null) {
		state.effect.last = prev;
	} else {
		next.prev = prev;
	}
}

function validate_each_keys(array: any[], key_fn: (item: any, index: number) => string) {
	const keys = new Map();
	const length = array.length;

	for (let i = 0; i < length; i++) {
		const key = key_fn(array[i], i);

		if (keys.has(key)) {
			const a = String(keys.get(key));
			const b = String(i);

			let k: string | null = String(key);
			if (k.startsWith('[object ')) k = null;

			e.each_key_duplicate(a, b, k);
		}

		keys.set(key, i);
	}
}
