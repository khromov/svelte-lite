import type {
	BatchRecord,
	BatchValue,
	Derived,
	DerivedRecord,
	Effect,
	Reaction,
	Source,
	Value
} from '../types.ts';
import type { Batch } from './batch.ts';
import { DEV } from 'esm-env';
import {
	DERIVED,
	DIRTY,
	EFFECT_PRESERVED,
	DESTROYED,
	INERT,
	CONNECTED,
	ASSIGNED,
	HAS_ABORT_CONTROLLER
} from '../constants.ts';
import {
	active_effect,
	update_reaction,
	set_active_effect,
	push_reaction_value,
	is_destroying_effect,
	update_effect,
	remove_reactions,
	is_current,
	promote_record,
	changed_since,
	is_dirty,
	abort_all
} from '../runtime.ts';
import { equals, safe_equals } from './equality.ts';
import * as e from '../errors.ts';
import * as w from '../warnings.ts';
import { destroy_effect, destroy_effect_children } from './effects.ts';
import { eager_effects, set_eager_effects } from './sources.ts';
import { get_error } from '../../shared/dev.ts';
import { async_mode_flag, tracing_mode_flag } from '../../flags/index.ts';
import { component_context } from '../context.ts';
import { UNINITIALIZED } from '../../../constants.ts';
import { batch_values, view_batch, view_cache } from './batch.ts';
import { includes, noop } from '../../shared/utils.ts';
import { update_derived_status } from './status.ts';
import { unsupported } from '../../../unsupported.ts';

/**
 * Dev-only state for the warning about signals that are read after an `await` which does not
 * restore the reactive context. Such an `await` takes `experimental.async`, which svelte-lite
 * leaves out, so neither `get` nor anything else here reads or sets it. The two names stay for
 * as long as `reactivity/async` imports them
 */
export let reactivity_loss_tracker: {
	effect: Effect;
	effect_deps: Set<Value>;
	warned: boolean;
} | null = null;

export function set_reactivity_loss_tracker(v: typeof reactivity_loss_tracker): void {
	reactivity_loss_tracker = v;
}

/*#__NO_SIDE_EFFECTS__*/
export function derived<V>(fn: () => V): Derived<V> {
	var flags = DERIVED | DIRTY;

	if (active_effect !== null) {
		// Since deriveds are evaluated lazily, any effects created inside them are
		// created too late to ensure that the parent effect is added to the tree
		active_effect.f |= EFFECT_PRESERVED;
	}

	const signal: Derived<V> = {
		ctx: component_context,
		deps: null,
		dv: null,
		edges: null,
		effects: null,
		equals,
		f: flags,
		fn,
		reactions: null,
		rv: 0,
		v: UNINITIALIZED as V,
		wv: 0,
		parent: active_effect,
		ac: null
	};

	if (DEV && tracing_mode_flag) {
		signal.created = get_error('created at');
	}

	return signal;
}

/**
 * What the pending run of an async expression is rejected with once it no longer counts.
 * `reactivity/batch` rejects with it; without async expressions, it has nothing to reject
 */
export const OBSOLETE = Symbol('obsolete');

/**
 * The signal of an `await` expression in a template or in a `$derived`. Those take
 * `experimental.async`, which svelte-lite leaves out and refuses to compile, so nothing is behind
 * this. The name stays for as long as `reactivity/async` imports it, which calls it for such
 * expressions only
 */
export function async_expression<V>(
	fn: () => V | Promise<V>,
	label?: string,
	location?: string,
	onready?: (error: unknown) => void
): Source<V> {
	unsupported('`experimental.async` in the browser');
}

/**
 * A `$derived` with an `await` in it, see `async_expression`. The name stays for as long as
 * `internal/client/index` re-exports it
 */
export function async_derived<V>(
	fn: () => V | Promise<V>,
	label?: string,
	location?: string
): Promise<Source<V>> {
	unsupported('`experimental.async` in the browser');
}

/**
 * Whether the signal of an async expression has no value yet in the active view of the world.
 * `reactivity/async` asks this of the signals `async_expression` returns
 */
export function is_uninitialized(signal: Source): boolean {
	return (batch_values?.get(signal) ?? signal).v === UNINITIALIZED;
}

/*#__NO_SIDE_EFFECTS__*/
export function user_derived<V>(fn: () => V): Derived<V> {
	const d = derived(fn);

	if (!async_mode_flag) push_reaction_value(d);

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
		w.derived_inert();

		// (as if it ran — it can't change anymore)
		update_derived_status(derived);

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

/**
 * Update the global state of a derived, adopting the active batch's run if its view has
 * become the real world (e.g. because a fork was committed), or re-evaluating it otherwise.
 * `signal` can be a source, too, which is cheaper than checking first (this is called for every dependency that
 * is checked): only reactions ever get a dirty status, so `is_dirty` returns `false` for a source right away
 */
export function update_derived(signal: Value): void {
	var derived = signal as Derived;

	if (!is_dirty(derived)) return;

	var records = view_batch?.records;
	var record = records?.get(derived);

	if (record !== undefined && is_current(record.deps, record.dv)) {
		(records as Map<Reaction, BatchRecord>).delete(derived);
		promote_record(derived, record);
	} else {
		// (the result is stored by `update_dependencies`)
		execute_derived(derived);
	}
}

/**
 * The value of `derived` as the view of the world of the active batch sees it, with its version: an
 * assigned value that holds, or a run of it whose versions are what the view holds — a record in the
 * batch, or the derived itself (i.e. its global state) — or else a new run. Results are cached for the
 * lifetime of the view (see `view_cache`), unless the derived is disconnected, in which case nothing
 * would remove them from the cache when they become stale.
 */
export function get_view(derived: Derived): Derived | DerivedRecord | BatchValue {
	var cache = view_cache as Map<Derived, Derived | DerivedRecord | BatchValue>;
	var entry = cache.get(derived);

	if (entry !== undefined) return entry;

	var batch = view_batch as Batch;

	// What the view holds for the derived is a write to it — an assignment (in this batch, or made while it commits),
	// or the value from before another batch's assignment that this view undoes — or else its global state. An assigned value
	// holds until one of the derived's dependencies — what its run in this view (its record in the batch, if
	// any, else its global run) read — is written after it (see `changed_since`). The value from before an
	// undone assignment is only used if it was assigned, too: a computed value was computed in some other
	// view of the world, and may depend on writes that this view undoes
	var written = (batch_values as Map<Value, BatchValue>).get(derived);
	var held = written ?? derived;
	var assigned = written === undefined ? (derived.f & ASSIGNED) !== 0 : written.assigned;
	var record = batch.get_record(derived) as DerivedRecord | undefined;

	if (assigned && !changed_since((record ?? derived).deps, held.wv)) {
		entry = held;
	} else if (record !== undefined && is_current(record.deps, record.dv)) {
		entry = record;
	} else if (
		written === undefined &&
		!assigned &&
		derived.dv !== null &&
		is_current(derived.deps, derived.dv)
	) {
		entry = derived;
	} else {
		execute_derived(derived);

		// the run is stored in the batch, unless it is the real-world value (see `update_record`)
		entry = (batch.records?.get(derived) as DerivedRecord | undefined) ?? derived;
	}

	if ((derived.f & CONNECTED) !== 0) {
		cache.set(derived, entry);
	}

	return entry;
}

export function freeze_derived_effects(derived: Derived): void {
	if (derived.effects === null) return;

	for (const e of derived.effects) {
		// if the effect has a teardown function or abort signal, call it
		if (e.teardown || (e.f & HAS_ABORT_CONTROLLER) !== 0) {
			e.teardown?.();
			abort_all(e);

			// make it a noop so it doesn't get called again if the derived
			// is unfrozen. we don't set it to `null`, because the existence
			// of a teardown function is what determines whether the
			// effect runs again during unfreezing (but not for teardown-only effects)
			if (e.fn !== null) e.teardown = noop;

			remove_reactions(e);
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
