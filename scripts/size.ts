/**
 * Measures what the client runtime costs an app. Each scenario is a small app that is
 * compiled, bundled and minified the way a production build would (rollup with
 * tree-shaking, `DEV` off, terser), then gzipped.
 *
 *   bun run size                       the headline scenarios
 *   bun run size --all                 all of them (about 140)
 *   bun run size counter each-keyed    the ones named
 *   SVELTE_IMPL=upstream bun run size  the same for Svelte itself, as the reference
 *
 * Results go to `.results/size-<impl>.json`. Measuring svelte-lite shows the difference to
 * Svelte for every scenario that has been measured for both.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { transform } from 'esbuild';
import { rollup, type Plugin } from 'rollup';
import { minify } from 'terser';
import { RESULTS, ROOT, UPSTREAM_PKG, get_impl } from '../harness/paths.ts';
import { create_resolver } from '../harness/resolve.ts';
// @ts-expect-error plain data modules, taken over from the size study of Svelte
import features from './size/features.mjs';
// @ts-expect-error
import realistic from './size/realistic.mjs';

interface Scenario {
	name: string;
	files: Record<string, string>;
	entry?: string;
	compilerOptions?: Record<string, unknown>;
}

interface Size {
	min: number;
	gzip: number;
}

const HEADLINE = [
	'static',
	'counter',
	'counter+hydrate',
	'each-keyed',
	'spread-attributes',
	'boundary-failed',
	'realistic-app',
	'realistic-app+transitions',
	'realistic-app+hydrate'
];

const DEFAULT_ENTRY = `import { mount } from 'svelte'; import App from './App.svelte'; mount(App, { target: document.body });`;

const impl = get_impl();
const { resolve, upstream_pkg } = create_resolver(impl);

const { compile, compileModule } = await import(
	impl === 'lite' ? '../src/compiler/index.ts' : path.join(UPSTREAM_PKG, 'src/compiler/index.js')
);

/** The app's own files live here, as far as the bundler is concerned */
const APP = '/__app__/';

function bundler(scenario: Scenario): Plugin {
	const files = new Map<string, string>([[`${APP}entry.js`, scenario.entry ?? DEFAULT_ENTRY]]);

	for (const [name, source] of Object.entries(scenario.files)) {
		const options = { filename: name, generate: 'client', dev: false, ...scenario.compilerOptions };

		if (name.endsWith('.svelte')) {
			const compiled = compile(source, { discloseVersion: false, css: 'external', ...options });
			files.set(APP + name, compiled.js.code);
		} else {
			files.set(APP + name, name.endsWith('.svelte.js') ? compileModule(source, options).js.code : source);
		}
	}

	return {
		name: 'svelte-lite:size',

		resolveId(id, importer) {
			if (id === `${APP}entry.js`) return id;

			// a production build for the browser
			if (id === 'esm-env') return '\0esm-env';

			if (importer?.startsWith(APP) && id.startsWith('.')) {
				return path.resolve(path.dirname(importer), id);
			}

			const resolved = resolve(id, importer);
			if (resolved) return resolved;

			if (id.startsWith('#')) {
				const entry = upstream_pkg.imports?.[id];
				const target = typeof entry === 'string' ? entry : entry?.default;
				return target ? path.resolve(UPSTREAM_PKG, target) : null;
			}

			if (id.startsWith('.')) return path.resolve(path.dirname(importer!), id);

			return fileURLToPath(import.meta.resolve(id));
		},

		load(id) {
			if (id === '\0esm-env') {
				return 'export const DEV = false; export const BROWSER = true; export const NODE = false;';
			}

			return files.get(id) ?? null;
		},

		async transform(code, id) {
			if (!id.endsWith('.ts')) return null;
			return (await transform(code, { loader: 'ts', target: 'esnext' })).code;
		}
	};
}

async function measure(scenario: Scenario): Promise<Size> {
	const bundle = await rollup({
		input: `${APP}entry.js`,
		plugins: [bundler(scenario)],
		onwarn() {}
	});

	const { output } = await bundle.generate({ format: 'es' });
	await bundle.close();

	const minified = await minify(output[0].code, {
		module: true,
		toplevel: true,
		compress: { passes: 2 },
		mangle: true
	});

	const code = minified.code ?? '';

	return {
		min: Buffer.byteLength(code),
		gzip: zlib.gzipSync(code, { level: 9 }).length
	};
}

const args = process.argv.slice(2);
const named = args.filter((arg) => !arg.startsWith('--'));
const wanted = named.length > 0 ? named : args.includes('--all') ? null : HEADLINE;
const scenarios = ([...features, ...realistic] as Scenario[]).filter(
	(scenario) => scenario.name !== 'empty-entry' && (!wanted || wanted.includes(scenario.name))
);

const file = (which: string) => path.join(RESULTS, `size-${which}.json`);
const read = (which: string): Record<string, Size> => {
	try {
		return JSON.parse(fs.readFileSync(file(which), 'utf8'));
	} catch {
		return {};
	}
};

const results = read(impl);
const reference = impl === 'lite' ? read('upstream') : {};
const format = (n: number) => n.toLocaleString('en-US');
const width = Math.max(...scenarios.map((scenario) => scenario.name.length));

console.log(`${'scenario'.padEnd(width)}  ${'min'.padStart(7)}  ${'gzip'.padStart(7)}${impl === 'lite' ? '  vs Svelte (gzip)' : ''}`);

for (const scenario of scenarios) {
	let line = scenario.name.padEnd(width);

	try {
		const size = (results[scenario.name] = await measure(scenario));
		const svelte = reference[scenario.name];

		line += `  ${format(size.min).padStart(7)}  ${format(size.gzip).padStart(7)}`;

		if (svelte) {
			const change = ((size.gzip - svelte.gzip) / svelte.gzip) * 100;
			line += `  ${format(svelte.gzip).padStart(7)}  ${change > 0 ? '+' : ''}${change.toFixed(1)}%`;
		}
	} catch (error) {
		delete results[scenario.name];
		line += `  ${String((error as Error).message).split('\n')[0].slice(0, 90)}`;
	}

	console.log(line);
}

fs.mkdirSync(RESULTS, { recursive: true });
fs.writeFileSync(file(impl), JSON.stringify(results, null, '\t'));
