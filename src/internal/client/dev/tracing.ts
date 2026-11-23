import type { Derived, Reaction, Value } from '../types.ts';
import { UNINITIALIZED } from '../../../constants.ts';
import { snapshot } from '../../shared/clone.ts';
import { DERIVED, ASYNC, PROXY_PATH_SYMBOL, STATE_SYMBOL } from '../constants.ts';
import { effect_tracking } from '../reactivity/effects.ts';
import { active_reaction, untrack } from '../runtime.ts';

type TraceEntry = {
	traces: Error[];
};

export let tracing_expressions: {
	reaction: Reaction | null;
	entries: Map<Value, TraceEntry>;
} | null = null;

function log_entry(signal: Value, entry?: TraceEntry): void {
	const value = signal.v;

	if (value === UNINITIALIZED) {
		return;
	}

	const type = get_type(signal);
	const current_reaction = active_reaction as Reaction;
	// whether the signal changed since the traced reaction last ran
	const dirty = signal.wv > current_reaction.wv || current_reaction.wv === 0;
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
		const deps = new Set((signal as Derived).deps);

		for (const dep of deps) {
			log_entry(dep);
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

			untrack(() => {
				for (const [signal, traces] of entries) {
					log_entry(signal, traces);
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
