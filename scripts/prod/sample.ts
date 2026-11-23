/**
 * Turns a sample of the runtime-runes suite into what an app ships: its components compiled
 * for production and bundled with the runtime, see bundle.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse, type Node } from 'acorn';
import type { OutputChunk, Plugin, RollupCache } from 'rollup';
import { ROOT, UPSTREAM_SRC, UPSTREAM_TESTS, get_impl, is_inside } from '../../harness/paths.ts';
import { bundle, minify, production } from './bundle.ts';

export const SUITE = 'runtime-runes';
export const SAMPLES = path.join(UPSTREAM_TESTS, SUITE, 'samples');

/** With `SVELTE_IMPL=upstream` it is Svelte that is bundled, as a control for the runner */
const impl = get_impl();

const SRC = impl === 'lite' ? path.join(ROOT, 'src') : UPSTREAM_SRC;

const { compile, compileModule }: typeof import('../../src/compiler/index.ts') = await import(
	impl === 'lite' ? '../../src/compiler/index.ts' : path.join(UPSTREAM_SRC, 'compiler/index.js')
);

const STAND_INS = path.join(import.meta.dirname, 'stand-ins.ts');
const PAGE = path.join(import.meta.dirname, 'page.ts');
const ANIMATION_HELPERS = path.join(UPSTREAM_TESTS, 'animation-helpers.js');

/** Modules of the suite that a `_config.js` imports and that cannot be bundled, see stand-ins.ts */
const REPLACED = [`${SUITE}/test`, 'helpers', 'suite'].map((file) => path.join(UPSTREAM_TESTS, file));

const ENTRY = '\0sample:entry';
const START = '\0sample:start';
const NO_CONFIG = '\0sample:no-config';

export interface Config {
	/** What the suite passes to the compiler for this sample, with `dev` off unless the sample turns it on */
	compile_options: Record<string, any>;
	/** Whether `_config.js` has this property */
	has: (key: string) => boolean;
	/** Whether the `test` function takes this, such as `logs` or `raf`. The suite goes by that as well */
	asks_for: (name: string) => boolean;
}

/**
 * Reads the `_config.js` of a sample without running it. It can only run inside the bundle,
 * as it imports the runtime, and the compiler has to know its options before there is one.
 */
export function read_config(name: string): Config {
	const dir = path.join(SAMPLES, name);
	const file = path.join(dir, '_config.js');
	const source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'export default {}';

	const unreadable = (what: string) =>
		new Error(`Cannot tell ${what} of ${name}/_config.js without running it`);

	const properties = new Map<string, Node>();

	for (const node of parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body) {
		if (node.type !== 'ExportDefaultDeclaration') continue;

		// `export default test({ ... })`
		const object =
			node.declaration.type === 'CallExpression' ? node.declaration.arguments[0] : node.declaration;

		if (object?.type !== 'ObjectExpression') throw unreadable('the properties');

		for (const property of object.properties) {
			if (property.type !== 'Property' || property.key.type !== 'Identifier' || property.computed) {
				throw unreadable('the properties');
			}

			properties.set(property.key.name, property.value);
		}
	}

	const text = (node: Node) => source.slice(node.start, node.end);

	const evaluate = (key: string) => {
		const node = properties.get(key);

		try {
			return node && new Function(`return (${text(node)});`)();
		} catch {
			throw unreadable(`\`${key}\``);
		}
	};

	const own = evaluate('compileOptions') ?? {};
	const test = properties.get('test');
	const parameters = test && 'params' in test ? (test.params as Node[]).map(text).join(', ') : '';

	return {
		// as `common_setup` in tests/runtime-legacy/shared.ts puts them together
		compile_options: {
			generate: 'client',
			rootDir: dir,
			dev: false,
			experimental: { async: false },
			fragments: 'html',
			...own,
			immutable: evaluate('immutable'),
			accessors: properties.has('accessors') ? evaluate('accessors') : true,
			runes: 'runes' in own ? own.runes : true
		},
		has: (key) => properties.has(key),
		asks_for: (name) => parameters.includes(name)
	};
}

/**
 * The first module of a bundle to run. With the config on `window` before the components
 * load, a sample can expect that to fail.
 */
function start(with_raf: boolean) {
	if (!with_raf) return `import config from './_config.js'; window.__sample = { config };`;

	// The suite replaces the clock of the runtime with one that the test moves by hand,
	// before it loads the components
	return `
		import { raf } from '${ANIMATION_HELPERS}';
		import config from './_config.js';

		raf.reset();
		window.__sample = { config, raf };
	`;
}

function entry(config: Config) {
	// In the suite `component`, which is what a test sets props on, is always a proxy. A sample
	// that has no props would pay for `proxy()` here without using it
	const with_proxy = config.has('props') || config.asks_for('component');

	return `
		import '${START}';
		import component from './main.svelte';
		import { flushSync, mount, unmount } from 'svelte';
		${with_proxy ? `import { proxy } from 'svelte/internal/client';` : ''}

		Object.assign(window.__sample, { component, flushSync, mount, unmount${with_proxy ? ', proxy' : ''} });
	`;
}

/** Serves the files of a sample to the bundler, compiled */
function sample(dir: string, config: Config, css: Map<string, string>, with_raf: () => boolean): Plugin {
	const exists = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.isFile();

	return {
		name: 'svelte-lite:sample',

		resolveId(id, importer) {
			if (id === ENTRY || id === START || id === ANIMATION_HELPERS) return id;

			// One sample imports the server runtime, for a branch that the browser does not
			// take. It loads these when it is used
			if (id.startsWith('node:')) return { id, external: true };

			const base =
				importer === ENTRY || importer === START
					? dir
					: importer && is_inside(importer, dir)
						? path.dirname(importer)
						: null;

			if (!base) return null;

			if (id === 'vitest') {
				this.error('imports vitest, which is not there in a bundle');
			}

			if (!id.startsWith('.')) return null;

			const target = path.resolve(base, id);

			// imports of Svelte's internals by path lead to compat/, as they do in the suite
			if (impl === 'lite' && is_inside(target, UPSTREAM_SRC)) return null;

			if (REPLACED.includes(target.replace(/\.[jt]s$/, ''))) return STAND_INS;

			if (importer === START && !exists(target)) return NO_CONFIG;

			return [target, `${target}.js`, `${target}.ts`].find(exists) ?? null;
		},

		load(id) {
			if (id === ENTRY) return entry(config);
			if (id === START) return start(with_raf());
			if (id === NO_CONFIG) return 'export default {};';

			return null;
		},

		transform(code, id) {
			if (!is_inside(id, dir)) return null;

			if (id.endsWith('.svelte')) {
				const compiled = compile(code, { ...config.compile_options, filename: id });
				if (compiled.css) css.set(id, compiled.css.code);

				return { code: compiled.js.code, map: null };
			}

			if (/\.svelte\.[jt]s$/.test(id)) {
				const { generate, dev, experimental } = config.compile_options;
				const compiled = compileModule(code, { filename: id, generate, dev, experimental });

				return { code: compiled.js.code, map: null };
			}

			return null;
		}
	};
}

/**
 * Whether the clock of the runtime is in a bundle. Only then is the suite's put there too, see
 * `start`: it comes with parts of the runtime that the sample may not use otherwise
 */
function uses_raf(chunk: OutputChunk) {
	return Object.entries(chunk.modules).some(
		([id, module]) => is_inside(id, SRC) && module.renderedExports.includes('raf')
	);
}

type CachedModule = RollupCache['modules'][number];

const is_own = (module: CachedModule) => module.id.startsWith('\0sample:') || is_inside(module.id, SAMPLES);

export interface BuildOptions {
	/** Also minify, with the options that `bun run size` measures with */
	minify: boolean;
	/** Leave `DEV` on */
	dev: boolean;
	/** Reuse what earlier builds have parsed */
	cache: boolean;
}

export function sample_builder(options: BuildOptions) {
	const runtime = production(impl, options);

	/**
	 * The modules of the runtime as rollup has parsed them for earlier samples. A build takes
	 * from here what it would otherwise transform and parse again, and then decides for itself
	 * what of that the sample needs, so the bundle is the same as without, byte for byte.
	 */
	const parsed = new Map<string, CachedModule>();

	return async (name: string, config: Config) => {
		const dir = path.join(SAMPLES, name);
		const css = new Map<string, string>();

		let with_raf = config.asks_for('raf');
		let own: CachedModule[] = [];

		const plugins = [sample(dir, config, css, () => with_raf), runtime];

		const build = async () => {
			const { chunk, cache } = await bundle(ENTRY, plugins, {
				cache: options.cache && { modules: [...parsed.values(), ...own] }
			});

			for (const module of cache?.modules ?? []) {
				// (rollup would also stick to the names it gave to variables, which depend on
				// what else was in the bundle they were chosen for)
				if (!is_own(module)) parsed.set(module.id, { ...module, safeVariableNames: null });
			}

			own = cache?.modules.filter(is_own) ?? [];

			return chunk;
		};

		let chunk = await build();

		// only now is it known whether the sample uses the clock, which takes a second build
		if (!with_raf && uses_raf(chunk)) {
			with_raf = true;
			chunk = await build();
		}

		return {
			code: wrap(options.minify ? await minify(chunk.code) : chunk.code, `${name}.js`),
			// as the suite puts them in the document
			styles: [...css.values()].join('\n').replace(/\/\*<\/?style>\*\//g, '')
		};
	};
}

/** The code of page.ts and what it imports, for the window */
export async function build_page() {
	const vitest = '\0sample:vitest';

	const plugin: Plugin = {
		name: 'svelte-lite:page',

		// `assert` is all that tests/html_equal.js wants of vitest, which has it from chai
		resolveId: (id) => (id === 'vitest' ? vitest : null),
		load: (id) => (id === vitest ? `export { assert } from 'chai';` : null)
	};

	const { chunk } = await bundle(PAGE, [plugin, production(impl)]);

	return wrap(chunk.code, 'page.js');
}

/**
 * A bundle is an ES module without imports or exports. This makes it a script that a window
 * can evaluate, with the scope and the strictness of a module.
 */
function wrap(code: string, name: string) {
	return `(function () {\n'use strict';\n${code}\n})();\n//# sourceURL=${name}`;
}
