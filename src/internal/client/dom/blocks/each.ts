import type {
	EachItem,
	EachOutroGroup,
	Effect,
	EffectNodes,
	MaybeSource,
	TemplateNode
} from '../../types.ts';
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
	get_next_sibling
} from '../operations.ts';
import {
	block,
	branch,
	destroy_effect,
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
import * as e from '../../errors.ts';
import { tag } from '../../dev/tracing.ts';

// When making substantive changes to this file, validate them with the each block stress test:
// https://svelte.dev/playground/1972b2cf46564476ad8c8c6405b23b7b
// This test also exists in the Svelte repo, as `packages/svelte/tests/manual/each-stress-test`

export function index(_: any, i: number) {
	return i;
}

function destroy_effects(to_destroy: Effect[], remove_dom = true) {
	for (var i = 0; i < to_destroy.length; i++) {
		destroy_effect(to_destroy[i], remove_dom);
	}
}

/** Where items that are created after the first run render to, until `reconcile` moves them into place */
var offscreen_anchor: Text | undefined;

/**
 * @param node The next sibling node, or the parent node if this is a 'controlled' block
 * @param fallback_fn Renders the `{:else}`. It has no default value on purpose: a bundler works out
 * that no each block of an app passes it only for a parameter without one, and then leaves out
 * what is behind a test that starts with `fallback_fn`
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
	fallback_fn?: (anchor: Node) => void
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

	/** The groups of items that are transitioning out together */
	var outrogroups: Set<EachOutroGroup> | null = null;

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

	var first_run = true;

	// `pause_effects` and `reconcile` are in here so that what they share with the block is held in
	// variables. In Svelte it is the fields of a state object, whose names a minifier has to keep

	/**
	 * Pause multiple effects simultaneously, and coordinate their
	 * subsequent destruction
	 */
	function pause_effects(to_destroy: Effect[], controlled_anchor: null | Node) {
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
							var groups = outrogroups as Set<EachOutroGroup>;

							destroy_effects(array_from(group.done));
							groups.delete(group);

							if (groups.size === 0) {
								outrogroups = null;
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
			// we can use the fast path — emptying the element and replacing the anchor
			if (controlled_anchor !== null) {
				var parent_node = controlled_anchor.parentNode as Element;

				clear_text_content(parent_node);
				parent_node.append(controlled_anchor);

				items.clear();
			}

			destroy_effects(to_destroy, controlled_anchor === null);
		} else {
			group = {
				pending: new Set(to_destroy),
				done: new Set()
			};

			(outrogroups ??= new Set()).add(group);
		}
	}

	/**
	 * Add, remove, or reorder items output by an each block as its input changes.
	 * Svelte works out the smallest set of moves. This walks the new order instead, and moves every
	 * item that is not where the walk has got to in front of what is there
	 */
	function reconcile(array: V[]): void {
		var is_animated = (flags & EACH_IS_ANIMATED) !== 0;

		var length = array.length;
		var current = skip_to_branch(each_effect.first);

		var to_animate: undefined | Set<Effect>;

		var to_destroy: Effect[] = [];

		/** The effects of the items that stay or come in, in their new order */
		var kept = new Set<Effect>();

		var effect: Effect;

		var i: number;

		for (i = 0; i < length; i += 1) {
			kept.add((items.get(get_key(array[i], i)) as EachItem).e);
		}

		/**
		 * Pass over what is going away, from where the walk has got to. It stays where it is:
		 * it may have a transition to play, and moving the items that stay around it costs more
		 */
		function skip() {
			while (current !== null && !kept.has(current)) {
				// If the each block isn't inert, then inert effects are currently outroing and will be removed once the transition is finished
				if ((current.f & INERT) === 0 && current !== fallback) {
					to_destroy.push(current);
				}

				current = skip_to_branch(current.next);
			}
		}

		if (is_animated) {
			for (effect of kept) {
				// offscreen == coming in now, no animation in that case,
				// else this would happen https://github.com/sveltejs/svelte/issues/17181
				if ((effect.f & EFFECT_OFFSCREEN) === 0) {
					effect.nodes?.a?.measure();
					(to_animate ??= new Set()).add(effect);
				}
			}
		}

		for (effect of kept) {
			if (outrogroups !== null) {
				for (const group of outrogroups) {
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

			var offscreen = (effect.f & EFFECT_OFFSCREEN) !== 0;

			if (offscreen) {
				// a new item goes where the walk has got to, in front of anything there that is going away
				effect.f ^= EFFECT_OFFSCREEN;
			} else if (effect !== current) {
				skip();
			}

			if (effect !== current) {
				// (an item that is yet to be placed comes after `current`, which is therefore not `null`)
				link(each_effect, effect.prev, effect.next);
				link(each_effect, (current as Effect).prev, effect);
				link(each_effect, effect, current);

				move(effect, current, anchor);
			} else {
				current = skip_to_branch(effect.next);

				// (new items come last, so there is nothing after this one that is in the DOM)
				if (offscreen) move(effect, current, anchor);
			}
		}

		// What is left is not in the new order. (This comes before the outro groups are tidied up,
		// which can destroy `current`, and with that the way to what follows it)
		skip();

		if (outrogroups !== null) {
			for (const group of outrogroups) {
				if (group.pending.size === 0) {
					destroy_effects(array_from(group.done));
					outrogroups?.delete(group);
				}
			}

			if (outrogroups.size === 0) {
				outrogroups = null;
			}
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

			pause_effects(to_destroy, controlled_anchor);
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

	var each_effect = block(() => {
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
					item.e.f |= EFFECT_OFFSCREEN;
				}

				items.set(key, item);
			}

			keys.add(key);
		}

		if (fallback_fn && length === 0 && !fallback) {
			if (first_run) {
				fallback = branch(() => fallback_fn(anchor));
			} else {
				fallback = branch(() => fallback_fn((offscreen_anchor ??= create_text())));
				fallback.f |= EFFECT_OFFSCREEN;
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

		// (creating an item can run code that destroys the block, by unmounting the app for example)
		if (!first_run && (each_effect.f & DESTROYED) === 0) {
			// Creating an item can also change the collection, so it is read
			// again: an item that is no longer in it must not end up in the DOM
			array = get(each_array);

			reconcile(array);

			if (fallback_fn && fallback !== null) {
				if (array.length === 0) {
					if ((fallback.f & EFFECT_OFFSCREEN) === 0) {
						resume_effect(fallback);
					} else {
						fallback.f ^= EFFECT_OFFSCREEN;
						move(fallback, null, anchor);
					}
				} else {
					pause_effect(fallback, () => {
						fallback = null;
					});
				}
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

function link(parent: Effect, prev: Effect | null, next: Effect | null) {
	if (prev === null) {
		parent.first = next;
	} else {
		prev.next = next;
	}

	if (next === null) {
		parent.last = prev;
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
