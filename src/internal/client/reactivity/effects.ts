import type {
	ComponentContext,
	Derived,
	Effect,
	TemplateNode,
	TransitionManager
} from '../types.ts';
import type { Blocker } from './async.ts';
import {
	active_effect,
	active_reaction,
	update_effect,
	get,
	is_destroying_effect,
	remove_reactions,
	set_active_reaction,
	set_is_destroying_effect,
	teardown_version,
	untracking,
	abort_all
} from '../runtime.ts';
import {
	DIRTY,
	BRANCH_EFFECT,
	RENDER_EFFECT,
	EFFECT,
	DESTROYED,
	INERT,
	BLOCK_EFFECT,
	ROOT_EFFECT,
	EFFECT_TRANSPARENT,
	DERIVED,
	CLEAN,
	EAGER_EFFECT,
	HEAD_EFFECT,
	MAYBE_DIRTY,
	EFFECT_PRESERVED,
	USER_EFFECT,
	ASYNC,
	CONNECTED,
	MANAGED_EFFECT,
	DESTROYING,
	PAUSED
} from '../constants.ts';
import { invoke_error_boundary } from '../error-handling.ts';
import * as e from '../errors.ts';
import { DEV } from 'esm-env';
import { define_property } from '../../shared/utils.ts';
import { get_next_sibling } from '../dom/operations.ts';
import { component_context, dev_current_component_function, dev_stack } from '../context.ts';
import { Batch, collected_effects, set_teardown_context, teardown_context } from './batch.ts';
import { flatten } from './async.ts';
import { set_signal_status } from './status.ts';
import { unsupported } from '../../../unsupported.ts';

export function validate_effect(rune: '$effect' | '$effect.pre' | '$inspect'): void {
	if (active_effect === null) {
		if (active_reaction === null) {
			e.effect_orphan(rune);
		}

		e.effect_in_unowned_derived();
	}

	if (is_destroying_effect) {
		e.effect_in_teardown(rune);
	}
}

function push_effect(effect: Effect, parent_effect: Effect): void {
	var parent_last = parent_effect.last;
	if (parent_last === null) {
		parent_effect.last = parent_effect.first = effect;
	} else {
		parent_last.next = effect;
		effect.prev = parent_last;
		parent_effect.last = effect;
	}
}

function create_effect(type: number, fn: null | (() => void | (() => void))): Effect {
	var parent = active_effect;

	if (DEV) {
		// Ensure the parent is never an inspect effect
		while (parent !== null && (parent.f & EAGER_EFFECT) !== 0) {
			parent = parent.parent;
		}
	}

	if (parent !== null && (parent.f & INERT) !== 0) {
		type |= INERT;
	}

	var effect: Effect = {
		ctx: component_context,
		deps: null,
		dv: null,
		edges: null,
		nodes: null,
		f: type | DIRTY | CONNECTED,
		first: null,
		fn,
		last: null,
		next: null,
		parent,
		b: parent && parent.b,
		prev: null,
		teardown: null,
		wv: 0,
		ac: null,
		// the renderer the effect was created with, which is always the DOM: svelte-lite
		// has no custom renderers. The field is part of the shape of an effect
		r: null
	};

	if (DEV) {
		effect.component_function = dev_current_component_function;
	}

	var e: Effect | null = effect;

	if ((type & EFFECT) !== 0) {
		if (collected_effects !== null) {
			// created during traversal — collect and run afterwards
			collected_effects.push(effect);
		} else {
			// schedule for later
			Batch.ensure().schedule(effect, DIRTY);
		}
	} else if (fn !== null) {
		try {
			update_effect(effect);
		} catch (e) {
			destroy_effect(effect);
			throw e;
		}

		// if an effect doesn't need to be kept in the tree (because it
		// won't re-run, has no DOM, and has no teardown etc)
		// then we skip it and go to its child (if any)
		if (
			e.edges === null &&
			e.teardown === null &&
			e.nodes === null &&
			e.first === e.last && // either `null`, or a singular child
			(e.f & EFFECT_PRESERVED) === 0
		) {
			e = e.first;
			if ((type & BLOCK_EFFECT) !== 0 && (type & EFFECT_TRANSPARENT) !== 0 && e !== null) {
				e.f |= EFFECT_TRANSPARENT;
			}
		}
	}

	if (e !== null) {
		e.parent = parent;

		if (parent !== null) {
			push_effect(e, parent);
		}

		// if we're in a derived, add the effect there too
		if (
			active_reaction !== null &&
			(active_reaction.f & DERIVED) !== 0 &&
			(type & ROOT_EFFECT) === 0
		) {
			var derived = active_reaction as Derived;
			(derived.effects ??= []).push(e);
		}
	}

	return effect;
}

/**
 * Internal representation of `$effect.tracking()`
 */
export function effect_tracking(): boolean {
	return active_reaction !== null && !untracking;
}

export function teardown(fn: () => void): Effect {
	const effect = create_effect(RENDER_EFFECT, null);
	set_signal_status(effect, CLEAN);
	effect.teardown = fn;
	return effect;
}

/**
 * Internal representation of `$effect(...)`
 */
export function user_effect(fn: () => void | (() => void)): void | Effect {
	validate_effect('$effect');

	if (DEV) {
		define_property(fn, 'name', {
			value: '$effect'
		});
	}

	// Non-nested `$effect(...)` in a component should be deferred
	// until the component is mounted
	var flags = (active_effect as Effect).f;
	var defer =
		!active_reaction &&
		(flags & BRANCH_EFFECT) !== 0 &&
		component_context !== null &&
		!component_context.i;

	if (defer) {
		// Top-level `$effect(...)` in an unmounted component — defer until mount
		var context = component_context as ComponentContext;
		(context.e ??= []).push(fn);
	} else {
		// Everything else — create immediately
		return create_user_effect(fn);
	}
}

export function create_user_effect(fn: () => void | (() => void)): Effect {
	return create_effect(EFFECT | USER_EFFECT, fn);
}

/**
 * Internal representation of `$effect.pre(...)`
 */
export function user_pre_effect(fn: () => void | (() => void)): Effect {
	validate_effect('$effect.pre');
	if (DEV) {
		define_property(fn, 'name', {
			value: '$effect.pre'
		});
	}
	return create_effect(RENDER_EFFECT | USER_EFFECT, fn);
}

export function eager_effect(fn: () => void | (() => void)): Effect {
	return create_effect(EAGER_EFFECT, fn);
}

/**
 * Internal representation of `$effect.root(...)`
 */
export function effect_root(fn: () => void | (() => void)): () => void {
	Batch.ensure();
	const effect = create_effect(ROOT_EFFECT | EFFECT_PRESERVED, fn);

	return () => {
		destroy_effect(effect);
	};
}

/**
 * An effect root whose children can transition out
 */
export function component_root(fn: () => void): (options?: { outro?: boolean }) => Promise<void> {
	Batch.ensure();
	const effect = create_effect(ROOT_EFFECT | EFFECT_PRESERVED, fn);

	return (options = {}) => {
		return new Promise((fulfil) => {
			if (options.outro) {
				pause_effect(effect, () => {
					destroy_effect(effect);
					fulfil(undefined);
				});
			} else {
				destroy_effect(effect);
				fulfil(undefined);
			}
		});
	};
}

export function effect(fn: () => void | (() => void)): Effect {
	return create_effect(EFFECT, fn);
}

/**
 * Internal representation of `$: ..`. Only a legacy mode component is compiled to a call of
 * this, so nothing is behind it. The name stays for as long as `internal/client/index`
 * re-exports it.
 */
export function legacy_pre_effect(): never {
	unsupported('legacy mode: components have to use runes');
}

/** See `legacy_pre_effect` */
export function legacy_pre_effect_reset(): never {
	unsupported('legacy mode: components have to use runes');
}

export function async_effect(fn: () => void | (() => void)): Effect {
	return create_effect(ASYNC | EFFECT_PRESERVED, fn);
}

export function render_effect(fn: () => void | (() => void), flags = 0): Effect {
	return create_effect(RENDER_EFFECT | flags, fn);
}

export function template_effect(
	fn: (...expressions: any) => void | (() => void),
	sync: Array<() => any> = [],
	async: Array<() => Promise<any>> = [],
	blockers: Blocker[] = []
): void {
	flatten(blockers, sync, async, (values) => {
		create_effect(RENDER_EFFECT, () => {
			fn(...values.map(get));
		});
	});
}

/**
 * Like `template_effect`, but with an effect which is deferred until the batch commits
 */
export function deferred_template_effect(
	fn: (...expressions: any) => void | (() => void),
	sync: Array<() => any> = [],
	async: Array<() => Promise<any>> = [],
	blockers: Blocker[] = []
): void {
	flatten(blockers, sync, async, (values) => {
		create_effect(EFFECT, () => fn(...values.map(get)));
	});
}

export function block(fn: () => void, flags = 0): Effect {
	var effect = create_effect(BLOCK_EFFECT | flags, fn);
	if (DEV) {
		effect.dev_stack = dev_stack;
	}
	return effect;
}

export function managed(fn: () => void, flags = 0): Effect {
	var effect = create_effect(MANAGED_EFFECT | flags, fn);
	if (DEV) {
		effect.dev_stack = dev_stack;
	}
	return effect;
}

export function branch(fn: () => void): Effect {
	return create_effect(BRANCH_EFFECT | EFFECT_PRESERVED, fn);
}

export function execute_effect_teardown(effect: Effect): void {
	var teardown = effect.teardown;
	if (teardown !== null) {
		const previously_destroying_effect = is_destroying_effect;
		const previous_teardown_version = teardown_version;
		const previous_teardown_context = teardown_context;
		const previous_reaction = active_reaction;
		set_is_destroying_effect(true);
		set_active_reaction(null);
		try {
			teardown.call(null);
		} catch (error) {
			// Route teardown errors through the boundary system so that a live
			// ancestor <svelte:boundary> can handle them. Boundaries that are
			// themselves mid-teardown are skipped by invoke_error_boundary.
			invoke_error_boundary(error, effect.parent);
		} finally {
			set_is_destroying_effect(previously_destroying_effect, previous_teardown_version);
			set_teardown_context(previous_teardown_context);
			set_active_reaction(previous_reaction);
		}
	}
}

export function destroy_effect_children(signal: Effect, remove_dom = false): void {
	var effect = signal.first;
	signal.first = signal.last = null;

	while (effect !== null) {
		abort_all(effect);

		var next = effect.next;

		if ((effect.f & ROOT_EFFECT) !== 0) {
			// this is now an independent root
			effect.parent = null;
		} else {
			destroy_effect(effect, remove_dom);
		}

		effect = next;
	}
}

export function destroy_block_effect_children(signal: Effect): void {
	var effect = signal.first;

	while (effect !== null) {
		var next = effect.next;
		if ((effect.f & BRANCH_EFFECT) === 0) {
			destroy_effect(effect);
		}
		effect = next;
	}
}

export function destroy_effect(effect: Effect, remove_dom = true): void {
	var removed = false;

	if (
		(remove_dom || (effect.f & HEAD_EFFECT) !== 0) &&
		effect.nodes !== null &&
		effect.nodes.end !== null
	) {
		remove_effect_dom(effect.nodes.start, effect.nodes.end);
		removed = true;
	}

	effect.f |= DESTROYING;
	destroy_effect_children(effect, remove_dom && !removed);
	remove_reactions(effect);

	var transitions = effect.nodes && effect.nodes.t;

	if (transitions !== null) {
		for (const transition of transitions) {
			transition.stop();
		}
	}

	execute_effect_teardown(effect);

	effect.f ^= DESTROYING;
	effect.f |= DESTROYED;

	var parent = effect.parent;

	// If the parent doesn't have any children, then skip this work altogether
	if (parent !== null && parent.first !== null) {
		unlink_effect(effect);
	}

	if (DEV) {
		effect.component_function = null;
	}

	// `first` and `child` are nulled out in destroy_effect_children
	// we don't null out `parent` so that error propagation can work correctly
	effect.next =
		effect.prev =
		effect.teardown =
		effect.ctx =
		effect.deps =
		effect.dv =
		effect.edges =
		effect.fn =
		effect.nodes =
		effect.ac =
		effect.b =
			null;
}

export function remove_effect_dom(node: TemplateNode | null, end: TemplateNode): void {
	while (node !== null) {
		var next: TemplateNode | null = node === end ? null : get_next_sibling(node);

		node.remove();
		node = next;
	}
}

/**
 * Detach an effect from the effect tree, freeing up memory and
 * reducing the amount of work that happens on subsequent traversals
 */
export function unlink_effect(effect: Effect): void {
	var parent = effect.parent;
	var prev = effect.prev;
	var next = effect.next;

	if (prev !== null) prev.next = next;
	if (next !== null) next.prev = prev;

	if (parent !== null) {
		if (parent.first === effect) parent.first = next;
		if (parent.last === effect) parent.last = prev;
	}
}

/**
 * When a block effect is removed, we don't immediately destroy it or yank it
 * out of the DOM, because it might have transitions. Instead, we 'pause' it.
 * It stays around (in memory, and in the DOM) until outro transitions have
 * completed, and if the state change is reversed then we _resume_ it.
 * A paused effect does not update, and the DOM subtree becomes inert.
 */
export function pause_effect(effect: Effect, callback?: () => void, destroy = true): void {
	var transitions: TransitionManager[] = [];

	effect.f |= PAUSED;
	pause_children(effect, transitions, true);

	var fn = () => {
		if (destroy) destroy_effect(effect);
		if (callback) callback();
	};

	var remaining = transitions.length;

	if (remaining > 0) {
		var context = teardown_context;

		var check = () => {
			if (!--remaining) {
				var previous_context = teardown_context;

				try {
					if (context) {
						// Other outros can share this context, and state may have changed
						// since its derived values were cached.
						context.derived_cache.clear();
						set_teardown_context(context);
					}
					fn();
				} finally {
					if (context) set_teardown_context(previous_context);
				}
			}
		};

		for (var transition of transitions) {
			transition.out(check);
		}
	} else {
		fn();
	}
}

function pause_children(effect: Effect, transitions: TransitionManager[], local: boolean): void {
	if ((effect.f & INERT) !== 0) return;
	effect.f ^= INERT;

	var t = effect.nodes && effect.nodes.t;

	if (t !== null) {
		for (const transition of t) {
			if (transition.is_global || local) {
				transitions.push(transition);
			}
		}
	}

	var child = effect.first;

	while (child !== null) {
		var sibling = child.next;

		// If this child is a root effect, then it will become an independent root when its parent
		// is destroyed, it should therefore not become inert nor partake in transitions.
		if ((child.f & ROOT_EFFECT) === 0) {
			var transparent =
				(child.f & EFFECT_TRANSPARENT) !== 0 ||
				// If this is a branch effect without a block effect parent,
				// it means the parent block effect was pruned. In that case,
				// transparency information was transferred to the branch effect.
				((child.f & BRANCH_EFFECT) !== 0 && (effect.f & BLOCK_EFFECT) !== 0);
			// TODO we don't need to call pause_children recursively with a linked list in place
			// it's slightly more involved though as we have to account for `transparent` changing
			// through the tree.
			pause_children(child, transitions, transparent ? local : false);
		}

		child = sibling;
	}
}

/**
 * The opposite of `pause_effect`. We call this if (for example)
 * `x` becomes falsy then truthy: `{#if x}...{/if}`
 */
export function resume_effect(effect: Effect): void {
	effect.f &= ~PAUSED;
	resume_children(effect, true);
}

function resume_children(effect: Effect, local: boolean): void {
	// this subtree was paused for its own reasons (e.g. a block whose condition
	// is still false) — its controller will resume or destroy it
	if ((effect.f & PAUSED) !== 0) return;

	if ((effect.f & INERT) === 0) return;
	effect.f ^= INERT;

	// If a dependency of this effect may have changed while it was paused,
	// schedule the effect to update. we don't use `is_dirty`
	// here because we don't want to eagerly recompute a derived like
	// `{#if foo}{foo.bar()}{/if}` if `foo` is now `undefined`.
	if ((effect.f & CLEAN) === 0) {
		// Assumption: This happens during the commit phase of the batch, causing another flush, but it's safe
		Batch.ensure().schedule(effect, MAYBE_DIRTY);
	}

	var child = effect.first;

	while (child !== null) {
		var sibling = child.next;
		var transparent = (child.f & EFFECT_TRANSPARENT) !== 0 || (child.f & BRANCH_EFFECT) !== 0;
		// TODO we don't need to call resume_children recursively with a linked list in place
		// it's slightly more involved though as we have to account for `transparent` changing
		// through the tree.
		resume_children(child, transparent ? local : false);
		child = sibling;
	}

	var t = effect.nodes && effect.nodes.t;

	if (t !== null) {
		for (const transition of t) {
			if (transition.is_global || local) {
				transition.in();
			}
		}
	}
}

export function move_effect(effect: Effect, fragment: DocumentFragment): void {
	if (!effect.nodes) return;

	var node: TemplateNode | null = effect.nodes.start;
	var end = effect.nodes.end;

	while (node !== null) {
		var next: TemplateNode | null = node === end ? null : get_next_sibling(node);

		fragment.append(node);
		node = next;
	}
}
