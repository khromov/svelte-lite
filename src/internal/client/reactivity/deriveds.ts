import type { Derived } from '../types.ts';
import { DEV } from 'esm-env';
import {
	CLEAN,
	DERIVED,
	DIRTY,
	EFFECT_PRESERVED,
	DESTROYED,
	ERROR_VALUE,
	INERT
} from '../constants.ts';
import {
	active_effect,
	update_reaction,
	set_active_effect,
	push_reaction_value,
	is_destroying_effect,
	update_effect,
	remove_reactions,
	increment_write_version,
	has_abort_signals,
	abort_signal
} from '../runtime.ts';
import { equals, safe_equals } from './equality.ts';
import * as e from '../errors.ts';
import * as w from '../warnings.ts';
import { destroy_effect, destroy_effect_children } from './effects.ts';
import { eager_effects, set_eager_effects } from './sources.ts';
import { get_error } from '../../shared/dev.ts';
import { tracing_mode_flag } from '../../flags/index.ts';
import { component_context } from '../context.ts';
import { UNINITIALIZED } from '../../../constants.ts';
import { includes, noop } from '../../shared/utils.ts';
import { set_signal_status, update_derived_status } from './status.ts';

/**
 * Whether a derived has been created. Nothing but `derived` sets this, so that a bundler can
 * tell that an app without deriveds never gets to the code that keeps them up to date
 */
export let has_deriveds = false;

/*#__NO_SIDE_EFFECTS__*/
export function derived<V>(fn: () => V): Derived<V> {
	has_deriveds = true;

	if (active_effect !== null) {
		// Since deriveds are evaluated lazily, any effects created inside them are
		// created too late to ensure that the parent effect is added to the tree
		active_effect.f |= EFFECT_PRESERVED;
	}

	const signal: Derived<V> = {
		ctx: component_context,
		deps: null,
		effects: null,
		equals,
		f: DERIVED | DIRTY,
		fn,
		reactions: null,
		rv: 0,
		v: UNINITIALIZED as V,
		wv: 0,
		mv: 0,
		parent: active_effect
	};

	if (DEV && tracing_mode_flag) {
		signal.created = get_error('created at');
	}

	return signal;
}

/*#__NO_SIDE_EFFECTS__*/
export function user_derived<V>(fn: () => V): Derived<V> {
	const d = derived(fn);

	push_reaction_value(d);

	return d;
}

/*#__NO_SIDE_EFFECTS__*/
export function derived_safe_equal<V>(fn: () => V): Derived<V> {
	const signal = derived(fn);
	signal.equals = safe_equals;
	return signal;
}

export function destroy_derived_effects(derived: Derived): void {
	var effects = derived.effects;

	if (effects !== null) {
		derived.effects = null;

		for (var i = 0; i < effects.length; i += 1) {
			destroy_effect(effects[i]);
		}
	}
}

/**
 * The currently updating deriveds, used to detect infinite recursion
 * in dev mode and provide a nicer error than 'too much recursion'
 */
let stack: Derived[] = [];

export function execute_derived<T>(derived: Derived<T>): T {
	var prev_active_effect = active_effect;
	var parent = derived.parent;

	if (
		!is_destroying_effect &&
		parent !== null &&
		derived.v !== UNINITIALIZED && // if it was never evaluated before, it's guaranteed to fail downstream, so we try to execute instead
		(parent.f & (DESTROYED | INERT)) !== 0
	) {
		if (DEV) {
			w.derived_inert();
		}

		return derived.v;
	}

	// Check before pushing, so that a recursive call doesn't remove the outer evaluation from the stack.
	if (DEV && includes.call(stack, derived)) {
		e.derived_references_self();
	}

	set_active_effect(parent);

	var prev_eager_effects = eager_effects;

	if (DEV) {
		set_eager_effects(new Set());
		stack.push(derived);
	}

	try {
		destroy_derived_effects(derived);
		return update_reaction(derived);
	} finally {
		set_active_effect(prev_active_effect);

		if (DEV) {
			set_eager_effects(prev_eager_effects);
			stack.pop();
		}
	}
}

export function update_derived(derived: Derived): void {
	var flags = derived.f;
	var failed = false;

	try {
		var value = execute_derived(derived);
	} catch (error) {
		// Nothing took care of the error, so it goes on to whoever is reading the derived.
		// It is also the value of the derived now (see `update_reaction`)
		value = error;
		failed = true;
	}

	// (an error and a value that are the same thing still differ)
	if (!derived.equals(value) || ((derived.f ^ flags) & ERROR_VALUE) !== 0) {
		derived.wv = increment_write_version();
		derived.v = value;
	}

	// deriveds without dependencies should never be recomputed
	if (derived.deps === null) {
		set_signal_status(derived, CLEAN);
	} else {
		update_derived_status(derived);
	}

	if (failed) {
		throw value;
	}
}

export function freeze_derived_effects(derived: Derived): void {
	if (derived.effects === null) return;

	for (const e of derived.effects) {
		// if the effect has a teardown function or abort signal, call it
		// (the flag comes first: only then does a bundler drop the check with it)
		if ((has_abort_signals && e.ac) || e.teardown) {
			e.teardown?.();

			if (has_abort_signals) {
				abort_signal(e);
			}

			// make it a noop so it doesn't get called again if the derived
			// is unfrozen. we don't set it to `null`, because the existence
			// of a teardown function is what determines whether the
			// effect runs again during unfreezing (but not for teardown-only effects)
			if (e.fn !== null) e.teardown = noop;

			remove_reactions(e, 0);
			destroy_effect_children(e);
		}
	}
}

export function unfreeze_derived_effects(derived: Derived): void {
	if (derived.effects === null) return;

	for (const e of derived.effects) {
		// if the effect was previously frozen — indicated by the presence
		// of a teardown function — unfreeze it
		if (e.teardown && e.fn !== null) {
			update_effect(e);
		}
	}
}
