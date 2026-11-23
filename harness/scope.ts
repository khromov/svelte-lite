import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.ts';

/** Which part of Svelte a test exercises. Only the client runtime is svelte-lite's own */
export type Area = 'client' | 'compiler' | 'server';

export interface Scope {
	/** The features svelte-lite leaves out, by the short name used below */
	reasons: Record<string, string>;
	/** Suites that are left out as a whole and not run. Matched as a prefix of the suite name */
	suites: Record<string, string>;
	/** Tests that are left out, by suite. A name without its `(variant)` covers every variant */
	tests: Record<string, Record<string, string>>;
}

export const scope_file = path.join(ROOT, 'scope.json');

export function read_scope(): Scope {
	return JSON.parse(fs.readFileSync(scope_file, 'utf8'));
}

export function write_scope(scope: Scope) {
	const sorted = (object: Record<string, any>) =>
		Object.fromEntries(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));

	scope.tests = sorted(Object.fromEntries(Object.entries(scope.tests).map(([k, v]) => [k, sorted(v)])));
	fs.writeFileSync(scope_file, JSON.stringify(scope, null, '\t') + '\n');
}

/** `each-keyed (hydrate)` → `each-keyed` */
export function without_variant(name: string) {
	return name.replace(/ \([^)]*\)$/, '');
}

/** `runtime-runes > each-keyed (dom)` → [`runtime-runes`, `each-keyed (dom)`] */
export function split_key(key: string): [suite: string, name: string] {
	const index = key.indexOf(' > ');
	return [key.slice(0, index), key.slice(index + 3)];
}

/** The reason a test is out of scope, if it is */
export function unsupported_reason(scope: Scope, suite: string, name: string) {
	for (const prefix in scope.suites) {
		if (suite.startsWith(prefix)) return scope.suites[prefix];
	}

	const tests = scope.tests[suite];
	return tests?.[name] ?? tests?.[without_variant(name)] ?? null;
}

const COMPILER = [
	'compiler-errors',
	'css',
	'css-parse',
	'migrate',
	'parser-legacy',
	'parser-modern',
	'preprocess',
	'print',
	'snapshot',
	'sourcemaps',
	'validator'
];

const SERVER = ['server-side-rendering', 'runtime-browser/test-ssr', 'custom-renderers-server'];

export function area_of(suite: string, name: string): Area {
	if (COMPILER.includes(suite)) return 'compiler';
	if (SERVER.includes(suite) || suite.startsWith('src/internal/server/')) return 'server';
	if (/\((ssr|async-ssr)\)$/.test(name)) return 'server';
	return 'client';
}
