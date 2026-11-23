import type { Value } from '../types.ts';

export function equals(this: Pick<Value, 'v'>, value: unknown): boolean {
	return value === this.v;
}

export function safe_not_equal(a: unknown, b: unknown): boolean {
	return a != a
		? b == b
		: a !== b || (a !== null && typeof a === 'object') || typeof a === 'function';
}

export function safe_equals(this: Pick<Value, 'v'>, value: unknown): boolean {
	return !safe_not_equal(value, this.v);
}
