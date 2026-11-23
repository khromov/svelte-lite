import { describe, expect, test } from 'bun:test';
import type { BuildOptions, BuildResult } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { build } from './esbuild.ts';
import { COMPAT, ROOT, UPSTREAM_PKG, UPSTREAM_SRC, UPSTREAM_TESTS, get_impl } from './paths.ts';
import { suite_name } from './reporter.ts';
import { HarnessError, assert_not_upstream, create_resolver, read_package } from './resolve.ts';
import { svelte_impl } from './vite-plugin.ts';

const own = (file: string) => path.join(ROOT, file);
const upstream_test = (file: string) => path.join(UPSTREAM_TESTS, file);

describe('resolving for svelte-lite', () => {
	const resolve = create_resolver('lite');

	test('`svelte` is the client build of this package', () => {
		const importer = upstream_test('runtime-runes/samples/x/_config.js');

		expect(resolve('svelte', importer)).toBe(own('src/index-client.ts'));
		expect(resolve('svelte/internal/client', importer)).toBe(own('src/internal/client/index.ts'));
		expect(resolve('svelte/store', importer)).toBe(own('src/store/index-client.ts'));
	});

	test('compiled server output gets the server build', () => {
		const importer = upstream_test('runtime-runes/samples/x/_output/server/main.svelte.js');

		expect(resolve('svelte', importer)).toBe(own('src/index-server.ts'));
		expect(resolve('svelte/store', importer)).toBe(own('src/store/index-server.ts'));
	});

	test('`force_server` gets the server build everywhere', () => {
		const resolve = create_resolver('lite', { force_server: true });
		const importer = upstream_test('custom-renderers-server/test.ts');

		expect(resolve('svelte/renderer', importer)).toBe(own('src/renderer/index-server.ts'));
	});

	test('an export that does not exist is an error, not a fallback to real Svelte', () => {
		expect(() => resolve('svelte/nope', upstream_test('store/test.ts'))).toThrow(HarnessError);
		// only has types
		expect(() => resolve('svelte/action', upstream_test('store/test.ts'))).toThrow(HarnessError);
	});

	test('relative imports of upstream internals go to compat/', () => {
		expect(
			resolve('../../src/internal/client/reactivity/batch.js', upstream_test('runtime-legacy/shared.ts'))
		).toBe(path.join(COMPAT, 'internal/client/reactivity/batch.ts'));

		// no extension
		expect(resolve('../../src/internal/client/proxy', upstream_test('signals/test.ts'))).toBe(
			path.join(COMPAT, 'internal/client/proxy.ts')
		);

		// a directory
		expect(resolve('../../src/internal/flags', upstream_test('signals/test.ts'))).toBe(
			path.join(COMPAT, 'internal/flags/index.ts')
		);
	});

	test('`#subpath` imports of the upstream package go to compat/', () => {
		expect(resolve('#client/constants', upstream_test('html_equal.js'))).toBe(
			path.join(COMPAT, 'internal/client/constants.ts')
		);
	});

	test('unit tests in upstream `src/` import shims instead of their neighbours', () => {
		const importer = path.join(UPSTREAM_SRC, 'reactivity/set.test.ts');

		expect(resolve('./set.js', importer)).toBe(path.join(COMPAT, 'reactivity/set.ts'));
		expect(resolve('../index-client.js', importer)).toBe(path.join(COMPAT, 'index-client.ts'));
	});

	test('an upstream internal without a shim is an error', () => {
		expect(() =>
			resolve('../../src/compiler/phases/1-parse/index.js', upstream_test('store/test.ts'))
		).toThrow(/Missing compat shim compat\/compiler\/phases\/1-parse\/index\.ts/);
	});

	test('everything else is left alone', () => {
		expect(resolve('../helpers.js', upstream_test('store/test.ts'))).toBeNull();
		expect(resolve('vitest', upstream_test('store/test.ts'))).toBeNull();
		expect(resolve('./main.svelte', upstream_test('runtime-runes/samples/x/_config.js'))).toBeNull();
		// files of this repo can import whatever they like
		expect(resolve('../vendor/svelte/packages/svelte/src/version.js', own('compat/x.ts'))).toBeNull();
	});
});

describe('resolving for upstream', () => {
	const resolve = create_resolver('upstream');

	test('`svelte` is the upstream package', () => {
		expect(resolve('svelte', upstream_test('store/test.ts'))).toBe(
			path.join(UPSTREAM_SRC, 'index-client.js')
		);
		expect(resolve('svelte', upstream_test('x/_output/server/main.svelte.js'))).toBe(
			path.join(UPSTREAM_SRC, 'index-server.js')
		);
	});

	test('internals are not redirected', () => {
		expect(resolve('../../src/internal/client/proxy', upstream_test('signals/test.ts'))).toBeNull();
		expect(resolve('#client/constants', upstream_test('html_equal.js'))).toBeNull();
	});
});

describe('guarding against real Svelte', () => {
	test('upstream sources are refused, upstream tests are not', () => {
		expect(() => assert_not_upstream(path.join(UPSTREAM_SRC, 'index-client.js'))).toThrow(
			HarnessError
		);
		expect(() => assert_not_upstream(own('node_modules/svelte/src/index-client.js'))).toThrow(
			HarnessError
		);

		assert_not_upstream(path.join(UPSTREAM_SRC, 'reactivity/set.test.ts'));
		assert_not_upstream(upstream_test('store/test.ts'));
		assert_not_upstream(own('src/index-client.ts'));
	});

	test('the vite plugin refuses to load them', () => {
		const load = svelte_impl('lite').load as (id: string) => null;
		const file = path.join(UPSTREAM_SRC, 'index-client.js');

		expect(() => load(`${file}?v=123`)).toThrow(HarnessError);
		expect((svelte_impl('upstream').load as typeof load)(file)).toBeNull();
	});

	test('the vite plugin swaps esbuild for the suite, and only for svelte-lite', () => {
		const resolve_id = (plugin: Plugin) =>
			plugin.resolveId as (id: string, importer: string) => string | null;
		const importer = upstream_test('runtime-browser/test.ts');

		expect(resolve_id(svelte_impl('lite'))('esbuild', importer)).toBe(own('harness/esbuild.ts'));
		expect(resolve_id(svelte_impl('lite'))('esbuild', own('harness/esbuild.ts'))).toBeNull();
		expect(resolve_id(svelte_impl('upstream'))('esbuild', importer)).toBeNull();
	});
});

describe('bundling with esbuild for svelte-lite', () => {
	const options: BuildOptions = {
		absWorkingDir: ROOT,
		bundle: true,
		write: false,
		metafile: true,
		format: 'esm',
		conditions: ['browser', 'production']
	};

	const stdin = (contents: string) => ({
		contents,
		resolveDir: upstream_test('runtime-browser'),
		sourcefile: upstream_test('runtime-browser/entry.js')
	});

	/** The files that ended up in the bundle, other than the entry point */
	const inputs = (result: BuildResult) =>
		Object.keys(result.metafile!.inputs).filter((file) => !file.includes('/runtime-browser/'));

	test('`svelte` resolves to this package, with the conditions of the build', async () => {
		const result = await build({
			...options,
			stdin: stdin(`import * as a from 'svelte'; import * as b from 'svelte/server'; console.log(a, b)`)
		});

		expect(inputs(result)).toEqual(['src/index-client.ts', 'src/server/index.ts']);
	});

	test('`#subpath` imports go to compat/', async () => {
		const result = await build({
			...options,
			entryPoints: [upstream_test('runtime-browser/assert.js')]
		});

		expect(inputs(result)).toEqual(['compat/internal/client/constants.ts']);
	});

	test('upstream paths that the suite resolves by hand go to compat/', async () => {
		const result = await build({
			...options,
			stdin: stdin(`import * as a from 'svelte'; console.log(a)`),
			plugins: [
				{
					// what tests/runtime-browser/test.ts does for its server bundle
					name: 'suite',
					setup(build) {
						build.onResolve({ filter: /./ }, (args) => {
							if (args.path === 'svelte') return { path: path.join(UPSTREAM_SRC, 'index-server.js') };
						});
					}
				}
			]
		});

		expect(inputs(result)).toEqual(['src/index-server.ts', 'compat/index-server.ts']);
	});

	test('upstream sources are refused', async () => {
		const file = path.join(UPSTREAM_SRC, 'version.js');
		const result = build({ ...options, stdin: stdin(`import ${JSON.stringify(file)}`) });

		await expect(result).rejects.toThrow(/Refusing to load real Svelte source/);
	});
});

describe('package.json', () => {
	const upstream = read_package(UPSTREAM_PKG).exports;
	const exports = read_package(ROOT).exports;

	test('has the entry points of the upstream package', () => {
		expect(Object.keys(exports).sort()).toEqual(Object.keys(upstream).sort());

		for (const [key, entry] of Object.entries(upstream)) {
			if (typeof entry === 'string') continue;

			// upstream builds its types and a CommonJS compiler, this package is its sources
			const conditions = Object.keys(entry).filter((c) => c !== 'types' && c !== 'require');
			const ours = Object.keys(exports[key]).filter((c) => c !== 'types');

			expect([key, ours]).toEqual([key, conditions]);
		}
	});

	test('every entry point exists', () => {
		for (const entry of Object.values(exports)) {
			for (const file of typeof entry === 'string' ? [entry] : Object.values(entry)) {
				expect([file, fs.existsSync(own(file))]).toEqual([file, true]);
			}
		}
	});
});

test('names suites after their test file', () => {
	const name = (file: string) => suite_name(path.join(UPSTREAM_PKG, file));

	expect(name('tests/runtime-runes/test.ts')).toBe('runtime-runes');
	expect(name('tests/runtime-browser/test-ssr.ts')).toBe('runtime-browser/test-ssr');
	expect(name('tests/css-parse.test.ts')).toBe('css-parse');
	expect(name('src/reactivity/set.test.ts')).toBe('src/reactivity/set');
});

test('SVELTE_IMPL selects the implementation', () => {
	expect(get_impl({})).toBe('lite');
	expect(get_impl({ SVELTE_IMPL: 'upstream' })).toBe('upstream');
	expect(() => get_impl({ SVELTE_IMPL: 'svelte' })).toThrow();
});
