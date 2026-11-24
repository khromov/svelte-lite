import { describe, expect, test } from 'bun:test';
import type { BuildOptions, BuildResult } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Plugin } from 'vite';
import { build } from './esbuild.ts';
import { COMPAT, ROOT, UPSTREAM_PKG, UPSTREAM_SRC, UPSTREAM_TESTS, get_impl } from './paths.ts';
import { suite_name } from './reporter.ts';
import { removed_from } from './removed.ts';
import { HarnessError, create_resolver, is_borrowed, is_reused, read_package, to_own } from './resolve.ts';
import { svelte_impl } from './vite-plugin.ts';

const own = (file: string) => path.join(ROOT, file);
const upstream_test = (file: string) => path.join(UPSTREAM_TESTS, file);

const upstream_src = (file: string) => path.join(UPSTREAM_SRC, file);

describe('resolving for svelte-lite', () => {
	const { resolve } = create_resolver('lite');

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
		const { resolve } = create_resolver('lite', { force_server: true });
		const importer = upstream_test('custom-renderers-server/test.ts');

		expect(resolve('svelte/renderer', importer)).toBe(own('src/renderer/index-server.ts'));
	});

	test('an export that does not exist is an error, not a fallback to real Svelte', () => {
		expect(() => resolve('svelte/nope', upstream_test('store/test.ts'))).toThrow(HarnessError);
		// only has types
		expect(() => resolve('svelte/action', upstream_test('store/test.ts'))).toThrow(HarnessError);
	});

	test('the drivers that mount components with `svelte/legacy` get a stand-in', () => {
		const support = own('harness/support/legacy.ts');

		expect(resolve('svelte/legacy', upstream_test('runtime-browser/driver.js'))).toBe(support);
		expect(resolve('svelte/legacy', upstream_test('hydration/test.ts'))).toBe(support);
		expect(resolve('svelte/legacy', upstream_test('runtime-legacy/shared.ts'))).toBe(support);
		// as Vite names the importer
		expect(resolve('svelte/legacy', `${upstream_test('hydration/test.ts')}?v=1`)).toBe(support);
	});

	test('anything else that imports `svelte/legacy` fails, and says why', () => {
		const importers = [
			upstream_test('runtime-runes/samples/mount-props-updates/main.svelte'),
			upstream_test('runtime-browser/assert.js'),
			own('src/index-client.ts')
		];

		for (const importer of importers) {
			expect(() => resolve('svelte/legacy', importer)).toThrow(/svelte-lite removed svelte\/legacy/);
		}

		// not even a driver gets anything else that was removed
		expect(() => resolve('svelte/legacy', undefined)).toThrow(/svelte-lite removed/);
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

	test('modules of Svelte that are still in use import svelte-lite\'s version of a module', () => {
		// a borrowed client module
		expect(resolve('./branches.js', upstream_src('internal/client/dom/blocks/if.js'))).toBe(
			own('src/internal/client/dom/blocks/branches.ts')
		);
		expect(resolve('#client/constants', upstream_src('internal/client/dom/blocks/if.js'))).toBe(
			own('src/internal/client/constants.ts')
		);

		// the server runtime
		expect(resolve('../shared/utils.js', upstream_src('internal/server/index.js'))).toBe(
			own('src/internal/shared/utils.ts')
		);
	});

	test('the compiler keeps to the modules it was written against', () => {
		expect(resolve('../utils.js', upstream_src('compiler/index.js'))).toBeNull();
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
	const { resolve } = create_resolver('upstream');

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
	const { resolve, check_load } = create_resolver('lite');

	// `svelte/internal/flags/legacy` is a module svelte-lite has its own version of
	const replaced = upstream_src('internal/flags/legacy.js');

	test('a module that svelte-lite has its own version of is refused', () => {
		expect(() => check_load(replaced)).toThrow(HarnessError);
		expect(() => check_load(`${replaced}?v=123`)).toThrow(HarnessError);
		expect(() => check_load(own('node_modules/svelte/src/index-client.js'))).toThrow(HarnessError);
	});

	test('the compiler, the server runtime and tests are not', () => {
		check_load(upstream_src('compiler/index.js'));
		check_load(upstream_src('internal/server/index.js'));
		check_load(upstream_src('index-server.js'));
		check_load(upstream_src('reactivity/set.test.ts'));
		check_load(upstream_test('store/test.ts'));
		check_load(own('src/index-client.ts'));

		expect(is_reused(upstream_src('compiler/phases/1-parse/index.js'))).toBe(true);
		expect(is_reused(upstream_src('index-client.js'))).toBe(false);
	});

	test('what the compiler imports from the rest of Svelte is allowed once it does', () => {
		const { resolve, check_load } = create_resolver('lite');
		const file = upstream_src('internal/flags/legacy.js');

		expect(() => check_load(file)).toThrow(HarnessError);
		resolve('../internal/flags/legacy.js', upstream_src('compiler/index.js'));
		check_load(file);
	});

	test('a module is borrowed for as long as its file says so', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-lite-'));
		const file = path.join(dir, 'module.ts');

		expect(is_borrowed(file)).toBe(false);

		fs.writeFileSync(file, `// @borrowed from Svelte\nexport * from './upstream.js';\n`);
		expect(is_borrowed(file)).toBe(true);

		fs.writeFileSync(file, `export const mine = true; // no longer borrowed\n`);
		fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
		expect(is_borrowed(file)).toBe(false);

		fs.rmSync(dir, { recursive: true });
	});

	test('`src/` mirrors the layout of upstream', () => {
		expect(to_own(upstream_src('internal/client/proxy.js'))).toBe(own('src/internal/client/proxy.ts'));
		expect(to_own(upstream_src('internal/client/types.d.ts'))).toBe(own('src/internal/client/types.ts'));
	});

	test('upstream is left alone entirely when it is the implementation under test', () => {
		create_resolver('upstream').check_load(replaced);
		expect(resolve('vitest', replaced)).toBeNull();
	});

	test('the vite plugin applies the guard', () => {
		const load = svelte_impl('lite').load as (id: string) => null;

		expect(() => load(`${replaced}?v=123`)).toThrow(HarnessError);
		expect((svelte_impl('upstream').load as typeof load)(replaced)).toBeNull();
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

		expect(inputs(result)).toContain('src/index-client.ts');
		expect(inputs(result)).toContain('src/server/index.ts');
	});

	test('`#subpath` imports go to compat/', async () => {
		const result = await build({
			...options,
			entryPoints: [upstream_test('runtime-browser/assert.js')]
		});

		expect(inputs(result)).toContain('compat/internal/client/constants.ts');
		expect(inputs(result)).toContain('src/internal/client/constants.ts');
	});

	test('upstream paths that the suite resolves by hand go to svelte-lite\'s version', async () => {
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

		expect(inputs(result)).toContain('src/index-server.ts');
		expect(inputs(result)).not.toContain('src/index-client.ts');
	});

	test('the driver gets the stand-in for `svelte/legacy`, and nothing else does', async () => {
		const driver = await build({
			...options,
			entryPoints: [upstream_test('runtime-browser/driver.js')],
			// what tests/runtime-browser/test.ts points these to does not matter here, as long as
			// they have a default export
			alias: {
				__MAIN_DOT_SVELTE__: own('package.json'),
				__CONFIG__: own('package.json'),
				'assert.js': upstream_test('runtime-browser/assert.js')
			}
		});

		expect(inputs(driver)).toContain('harness/support/legacy.ts');

		const other = build({ ...options, stdin: stdin(`import 'svelte/legacy'`) });
		await expect(other).rejects.toThrow(/svelte-lite removed svelte\/legacy/);
	});

	test('upstream sources are refused', async () => {
		const file = upstream_src('internal/flags/legacy.js');
		const result = build({ ...options, stdin: stdin(`import ${JSON.stringify(file)}`) });

		await expect(result).rejects.toThrow(/Refusing to load real Svelte source/);
	});
});

describe('package.json', () => {
	const upstream = read_package(UPSTREAM_PKG).exports;
	const exports = read_package(ROOT).exports;

	/** `./legacy` → `svelte/legacy` */
	const removed = (key: string) => removed_from(`svelte${key.slice(1)}`) === '*';

	test('has the entry points of the upstream package, minus the removed ones', () => {
		expect(Object.keys(exports).sort()).toEqual(Object.keys(upstream).filter((key) => !removed(key)).sort());

		for (const [key, entry] of Object.entries(upstream)) {
			if (typeof entry === 'string' || removed(key)) continue;

			// upstream builds its types and a CommonJS compiler, this package is its sources
			const conditions = Object.keys(entry).filter((c) => c !== 'types' && c !== 'require');
			const missing = conditions.filter((condition) => !(condition in (exports[key] as object)));

			expect([key, missing]).toEqual([key, []]);
		}
	});

	test('the server build of `svelte` has the exports of Svelte\'s, minus the removed ones', async () => {
		const upstream = Object.keys(await import(path.join(UPSTREAM_SRC, 'index-server.js')));
		const own = Object.keys(await import(path.join(ROOT, 'src/index-server.ts')));
		const removed = removed_from('svelte');

		expect(removed).not.toBe('*');
		expect(own.sort()).toEqual(upstream.filter((name) => !(removed as Set<string>).has(name)).sort());
	});

	test('every entry point exists', () => {
		for (const entry of Object.values(exports)) {
			for (const file of typeof entry === 'string' ? [entry] : Object.values(entry)) {
				expect([file, fs.existsSync(own(file))]).toEqual([file, true]);
			}
		}
	});

	test('test support is not part of what ships', () => {
		const files = Object.values(exports)
			.flatMap((entry) => (typeof entry === 'string' ? [entry] : Object.values(entry)))
			.filter((file) => file !== './package.json');

		for (const file of files) {
			expect([file, path.resolve(ROOT, file).startsWith(own('src') + path.sep)]).toEqual([file, true]);
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

test('names the version of Svelte whose compiler output it runs', async () => {
	const { VERSION } = await import('../src/version.ts');

	// src/version.ts holds the version as a literal, which has to follow the submodule
	expect(VERSION).toBe(read_package(UPSTREAM_PKG).version);
});
