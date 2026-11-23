import { DEV } from 'esm-env';
import { define_property } from './utils.ts';
import * as e from './errors.ts';

export function get_error(label: string): (Error & { stack: string }) | null {
	const error = new Error();
	const stack = get_stack();

	if (stack.length === 0) {
		return null;
	}

	stack.unshift('\n');

	define_property(error, 'stack', {
		value: stack.join('\n')
	});

	define_property(error, 'name', {
		value: label
	});

	return error as Error & { stack: string };
}

/**
 * Matches a stack frame of a function in this module, which is `internal/shared/dev.ts`, and
 * captures the path of `internal/`. V8 puts the path in parentheses, other engines after an `@`
 */
const OWN_FRAME = /[(@](.*\/internal\/)shared\/dev\./;

export function get_stack(): string[] {
	// @ts-ignore - doesn't exist everywhere
	const limit = Error.stackTraceLimit;
	// @ts-ignore - doesn't exist everywhere
	Error.stackTraceLimit = Infinity;
	const stack = new Error().stack;
	// @ts-ignore - doesn't exist everywhere
	Error.stackTraceLimit = limit;

	if (!stack) return [];

	const lines = stack.split('\n');
	const new_lines = [];

	// Svelte recognises its own frames by `svelte/src/internal` in their path. That holds for
	// the modules of Svelte that are in use here, but not for this package, which can be
	// installed under any name. Its location is read off the first frame instead, which is
	// this function's. V8 puts a line that names the error before it. In a bundle the frame
	// leads somewhere else, and frames cannot be told apart by their path there anyway
	const internal = OWN_FRAME.exec(lines.slice(0, 2).join('\n').replaceAll('\\', '/'))?.[1];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const posixified = line.replaceAll('\\', '/');

		if (line.trim() === 'Error') {
			continue;
		}

		if (line.includes('validate_each_keys')) {
			return [];
		}

		if (
			posixified.includes('svelte/src/internal') ||
			posixified.includes('node_modules/.vite') ||
			(internal !== undefined && posixified.includes(internal))
		) {
			continue;
		}

		new_lines.push(line);
	}

	return new_lines;
}

export function invariant(condition: boolean, message: string) {
	if (!DEV) {
		throw new Error('invariant(...) was not guarded by if (DEV)');
	}

	if (!condition) e.invariant_violation(message);
}
