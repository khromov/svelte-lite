import type {
	BatchRecord,
	BatchValue,
	Derived,
	DerivedRecord,
	Reaction,
	Value
} from '../types.ts';
import { UNINITIALIZED } from '../../../constants.ts';
import { snapshot } from '../../shared/clone.ts';
import { DERIVED, ASYNC, PROXY_PATH_SYMBOL, STATE_SYMBOL } from '../constants.ts';
import { effect_tracking } from '../reactivity/effects.ts';
import { batch_values, view_batch } from '../reactivity/batch.ts';
import { get_view } from '../reactivity/deriveds.ts';
import { active_reaction, run_of, untrack, version_of } from '../runtime.ts';

type TraceEntry = {
	traces: Error[];
};

export let tracing_expressions: {
	reaction: Reaction | null;
	entries: Map<Value, TraceEntry>;
} | null = null;

// A batch only has a view of the world that differs from the real one with `experimental.async`,
// which svelte-lite leaves out. `view_of` and `run_in_view` follow the scheduler all the same,
// for as long as it has views (`batch_values`, `view_batch`, `get_view`).

/**
 * The value of `signal`, with its version, as the active view of the world sees it (see `get`): for a
 * derived, the run of it that applies — a record in the batch, or the derived itself — or an assigned value
 */
function view_of(signal: Value): Value | DerivedRecord | BatchValue {
	if (batch_values === null) return signal;
	if ((signal.f & DERIVED) !== 0) return get_view(signal as Derived);
	return batch_values.get(signal) ?? signal;
}

/**
 * The run of `reaction` that applies in the active view of the world (see `run_of`), which for a derived
 * in the view of a batch is its record in the batch if it has one (see `get_view`). While the reaction
 * runs, that's its previous run
 */
function run_in_view(reaction: Reaction): Reaction | BatchRecord {
	if ((reaction.f & DERIVED) !== 0 && batch_values !== null) {
		return view_batch?.get_record(reaction) ?? reaction;
	}

	return run_of(reaction);
}

/**
 * Whether `signal` changed in the active view of the world since the traced reaction last ran. If its previous
 * run read it, that's whether the version it saw is no longer current. Otherwise (it's a dependency of a derived
 * the reaction read, or the reaction didn't read it before), whether it was written since `since`: the one place
 * where versions are compared by order, which is only a heuristic — a view can undo writes, which gives values
 * older versions again
 * @param run the previous run of the traced reaction (see `run_in_view`)
 * @param since the version of the reaction's previous run (`0` if there's none)
 */
function is_changed(signal: Value, run: Reaction | BatchRecord, since: number): boolean {
	var i = run.deps?.indexOf(signal) ?? -1;
	var seen = i === -1 ? undefined : run.dv?.[i];

	if (seen !== undefined) return version_of(signal) !== seen;

	return since === 0 || version_of(signal) > since;
}

/**
 * @param run the previous run of the traced reaction (see `run_in_view`)
 * @param since the version of the reaction's previous run (`0` if there's none)
 */
function log_entry(
	signal: Value,
	entry: TraceEntry | undefined,
	run: Reaction | BatchRecord,
	since: number
): void {
	const view = view_of(signal);
	const value = view.v;

	if (value === UNINITIALIZED) {
		return;
	}

	const type = get_type(signal);
	const dirty = is_changed(signal, run, since);
	const style = dirty
		? 'color: CornflowerBlue; font-weight: bold'
		: 'color: grey; font-weight: normal';

	// eslint-disable-next-line no-console
	console.groupCollapsed(
		signal.label ? `%c${type}%c ${signal.label}` : `%c${type}%c`,
		style,
		dirty ? 'font-weight: normal' : style,
		typeof value === 'object' && value !== null && STATE_SYMBOL in value
			? snapshot(value, true)
			: value
	);

	if ((signal.f & DERIVED) !== 0) {
		const deps = new Set(('deps' in view ? view : run_in_view(signal as Derived)).deps);

		for (const dep of deps) {
			log_entry(dep, undefined, run, since);
		}
	}

	if (signal.created) {
		// eslint-disable-next-line no-console
		console.log(signal.created);
	}

	if (dirty && signal.updated) {
		for (const updated of signal.updated.values()) {
			if (updated.error) {
				// eslint-disable-next-line no-console
				console.log(updated.error);
			}
		}
	}

	if (entry) {
		for (var trace of entry.traces) {
			// eslint-disable-next-line no-console
			console.log(trace);
		}
	}

	// eslint-disable-next-line no-console
	console.groupEnd();
}

function get_type(signal: Value): '$state' | '$derived' | 'store' {
	if ((signal.f & (DERIVED | ASYNC)) !== 0) return '$derived';
	return signal.label?.startsWith('$') ? 'store' : '$state';
}

export function trace<T>(label: () => string, fn: () => T): T {
	var previously_tracing_expressions = tracing_expressions;

	try {
		tracing_expressions = { entries: new Map(), reaction: active_reaction };

		var start = performance.now();
		var value = fn();
		var time = (performance.now() - start).toFixed(2);

		var prefix = untrack(label);

		if (!effect_tracking()) {
			// eslint-disable-next-line no-console
			console.log(`${prefix} %cran outside of an effect (${time}ms)`, 'color: grey');
		} else if (tracing_expressions.entries.size === 0) {
			// eslint-disable-next-line no-console
			console.log(`${prefix} %cno reactive dependencies (${time}ms)`, 'color: grey');
		} else {
			// eslint-disable-next-line no-console
			console.group(`${prefix} %c(${time}ms)`, 'color: grey');

			var entries = tracing_expressions.entries;
			var reaction = active_reaction as Reaction;
			var run = run_in_view(reaction);
			var since = run.wv ?? reaction.wv;

			untrack(() => {
				for (const [signal, traces] of entries) {
					log_entry(signal, traces, run, since);
				}
			});

			tracing_expressions = null;

			// eslint-disable-next-line no-console
			console.groupEnd();
		}

		return value;
	} finally {
		tracing_expressions = previously_tracing_expressions;
	}
}

export function tag<T extends Value>(source: T, label: string): T {
	source.label = label;
	tag_proxy(source.v, label);

	return source;
}

export function tag_proxy(value: unknown, label: string): unknown {
	(value as any)?.[PROXY_PATH_SYMBOL]?.(label);
	return value;
}

export function label(value: unknown): string {
	if (typeof value === 'symbol') return `Symbol(${value.description})`;
	if (typeof value === 'function') return '<function>';
	if (typeof value === 'object' && value) return '<object>';
	return String(value);
}
