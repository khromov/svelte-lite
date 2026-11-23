import type {
	ComponentContext,
	Derived,
	Effect,
	TemplateNode,
	TransitionManager
} from '../types.ts';
import {
	active_effect,
	active_reaction,
	update_effect,
	get,
	is_destroying_effect,
	remove_reactions,
	set_active_reaction,
	set_is_destroying_effect,
	untracking,
	has_abort_signals,
	abort_signal
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
	EFFECT_PRESERVED,
	USER_EFFECT,
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
import { collected_effects, schedule_effect } from './batch.ts';
import { derived, has_deriveds } from './deriveds.ts';
import { set_signal_status } from './status.ts';

/**
 * Whether an effect that waits for the DOM to be up to date (`$effect`, and what bindings, actions
 * and transitions use) has been created. Nothing but the functions that create one set this, so
 * that a bundler can tell that an app without such effects never has one to schedule or to run
 */
export let has_effects = false;

/**
 * Whether an element with a `transition:`, `in:`, `out:` or `animate:` directive has been created.
 * Nothing but `transition` and `animation` set this, before they give an effect its first
 * transition or animation, so that a bundler can tell that an app without those directives never
 * has a transition to play, to stop or to wait for, nor an item of an each block to animate.
 * Until it is set, `nodes.t` and `nodes.a` are `null` on every effect
 */
export let has_transitions = false;

export function set_has_transitions(): void {
	has_transitions = true;
}

/**
 * Checks that a rune that creates an effect is used where it can. Only called in dev mode
 */
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
		nodes: null,
		f: type | DIRTY | CONNECTED,
		first: null,
		fn,
		last: null,
		next: null,
		parent,
		prev: null,
		teardown: null,
		wv: 0
	};

	if (DEV) {
		effect.component_function = dev_current_component_function;
	}

	var e: Effect | null = effect;

	if (has_effects && (type & EFFECT) !== 0) {
		if (collected_effects !== null) {
			// created while the tree is being traversed — it runs with the effects of this flush
			collected_effects.push(effect);
		} else {
			// schedule for later
			schedule_effect(effect);
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
			e.deps === null &&
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
			has_deriveds &&
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
	if (DEV) {
		validate_effect('$effect');

		define_property(fn, 'name', {
			value: '$effect'
		});
	}

	has_effects = true;

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
	if (DEV) {
		validate_effect('$effect.pre');

		define_property(fn, 'name', {
			value: '$effect.pre'
		});
	}

	return create_effect(RENDER_EFFECT | USER_EFFECT, fn);
}

/**
 * The effect of an `$inspect`, which runs as soon as what it reads is written. Only created in dev mode
 */
export function eager_effect(fn: () => void | (() => void)): Effect {
	return create_effect(EAGER_EFFECT, fn);
}

/**
 * Internal representation of `$effect.root(...)`
 */
export function effect_root(fn: () => void | (() => void)): () => void {
	const effect = create_effect(ROOT_EFFECT | EFFECT_PRESERVED, fn);

	return () => {
		destroy_effect(effect);
	};
}

/**
 * The root effect of a mounted component. Unlike `effect_root` it hands out the effect itself:
 * `unmount` is what destroys it, after the outros if asked to, and an app that never unmounts
 * does not need the code for that
 */
export function component_root(fn: () => void | (() => void)): Effect {
	return create_effect(ROOT_EFFECT | EFFECT_PRESERVED, fn);
}

export function effect(fn: () => void | (() => void)): Effect {
	has_effects = true;

	return create_effect(EFFECT, fn);
}

export function render_effect(fn: () => void | (() => void), flags = 0): Effect {
	return create_effect(RENDER_EFFECT | flags, fn);
}

/**
 * The effect of the expressions in a template. Each of `sync` gets a derived, so that the effect
 * only runs when one of their values changes. The compiler passes the `await` expressions and
 * what they wait for after that, which only have content with `experimental.async`
 */
export function template_effect(
	fn: (...expressions: any) => void | (() => void),
	sync?: Array<() => any>
): void {
	create_effect(RENDER_EFFECT, sync ? with_expressions(fn, sync) : fn);
}

/**
 * Like `template_effect`, but with an effect that runs after the DOM has been updated
 */
export function deferred_template_effect(
	fn: (...expressions: any) => void | (() => void),
	sync?: Array<() => any>
): void {
	has_effects = true;

	create_effect(EFFECT, sync ? with_expressions(fn, sync) : fn);
}

function with_expressions(
	fn: (...expressions: any) => void | (() => void),
	sync: Array<() => any>
): () => void | (() => void) {
	var deriveds = expressions(sync);

	return () => fn(...deriveds.map(get));
}

/**
 * A derived for each of the expressions that the compiler hands to a template effect or
 * an attribute effect
 */
export function expressions(sync: Array<() => any>): Derived[] {
	var deriveds = sync.map(derived);

	if (DEV) {
		deriveds.forEach((d, i) => {
			// TODO this is kinda useful for debugging but a lousy implementation —
			// maybe the compiler could pass through the template string
			d.label = sync[i]
				.toString()
				.replace('() => ', '')
				.replaceAll('$.eager(() => ', '$state.eager(')
				.replace(/\$\.get\((.+?)\)/g, (_, id) => id);
		});
	}

	return deriveds;
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
			set_is_destroying_effect(previously_destroying_effect);
			set_active_reaction(previous_reaction);
		}
	}
}

export function destroy_effect_children(signal: Effect, remove_dom = false): void {
	var effect = signal.first;
	signal.first = signal.last = null;

	while (effect !== null) {
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

	if (has_abort_signals) {
		abort_signal(effect);
	}

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
	remove_reactions(effect, 0);

	if (has_transitions) {
		var transitions = effect.nodes && effect.nodes.t;

		if (transitions !== null) {
			for (const transition of transitions) {
				transition.stop();
			}
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
		effect.fn =
		effect.nodes =
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

	// (without transitions there is nothing to wait for, and pausing is synchronous)
	if (has_transitions && remaining > 0) {
		var check = () => --remaining || fn();

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

	if (has_transitions) {
		var t = effect.nodes && effect.nodes.t;

		if (t !== null) {
			for (const transition of t) {
				if (transition.is_global || local) {
					transitions.push(transition);
				}
			}
		}
	}

	var child = effect.first;

	while (child !== null) {
		var sibling = child.next;

		// If this child is a root effect, then it will become an independent root when its parent
		// is destroyed, it should therefore not become inert nor partake in transitions.
		if ((child.f & ROOT_EFFECT) === 0) {
			// (`local` only says which transitions take part)
			var transparent =
				has_transitions &&
				((child.f & EFFECT_TRANSPARENT) !== 0 ||
					// If this is a branch effect without a block effect parent,
					// it means the parent block effect was pruned. In that case,
					// transparency information was transferred to the branch effect.
					((child.f & BRANCH_EFFECT) !== 0 && (effect.f & BLOCK_EFFECT) !== 0));
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
		// (the traversal that passed over this effect while it was paused used up
		// the marks that lead to it, so it is scheduled again)
		schedule_effect(effect);
	}

	var child = effect.first;

	while (child !== null) {
		var sibling = child.next;
		var transparent =
			has_transitions &&
			((child.f & EFFECT_TRANSPARENT) !== 0 || (child.f & BRANCH_EFFECT) !== 0);
		// TODO we don't need to call resume_children recursively with a linked list in place
		// it's slightly more involved though as we have to account for `transparent` changing
		// through the tree.
		resume_children(child, transparent ? local : false);
		child = sibling;
	}

	if (has_transitions) {
		var t = effect.nodes && effect.nodes.t;

		if (t !== null) {
			for (const transition of t) {
				if (transition.is_global || local) {
					transition.in();
				}
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
