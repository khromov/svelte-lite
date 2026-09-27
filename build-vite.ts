#!/usr/bin/env bun
/**
 * The Vite counterpart of build.ts: the same variants x apps, bundled by Vite (Rolldown + the Oxc
 * minifier) instead of Bun.build(), then put through the same checks and measurement.
 *
 * bun run build-vite.ts [variant ...]      build variants (default: baseline) for every app
 * bun run build-vite.ts --all              build every variant in variants.ts
 *   --app=<name>  --no-check  --svelte=<ref>  --strict-hydration  --short-errors   as in build.ts
 *   --out=<dir>                            write to <dir>/<variant>/<app>/ instead of dist-vite/
 *
 * Into dist-vite/<variant>/<app>/, laid out like build.ts's dist/:
 *
 *   index.html        SSR output: Vite SSR build of apps/<app>/server.js, rendered with render()
 *                     from svelte/server, in the same page as build.ts (htmlPage)
 *   main.min.js       Vite's production build (build.minify: 'oxc') -> the number
 *   main.js           no minification (Rolldown `minify: false`; Vite's `build.minify: false` would
 *                     still run Oxc's 'dce-only' pass), like build.ts's `minify: false`
 *   main.readable.js  Oxc compress without mangling or whitespace removal: same dead-code elimination
 *                     as main.min.js, readable names + `// module` markers -> read this one
 *   meta.unmin.json   per-module bytes (Rolldown renderedLength) in Bun's metafile shape
 *   patches.log, report.json/.md (measure.ts)
 *
 * followed by check.ts's behavioural check on all three bundles, exactly as for build.ts.
 *
 * Shared with build.ts, so only the bundler differs: the Svelte source (scripts/link-svelte.ts),
 * the variant's patches and constImports (loadPatched), component compilation and the
 * compiled-output rewrites (compileSvelte), the HTML page, the checks and the measurement.
 * Everything else is Vite's production default: export conditions, NODE_ENV, build.target and
 * the minifier. Bun-only parts of a variant are skipped: `optimizeImports` (Bun's barrel
 * optimisation) and `postpass` (it re-bundles with Bun). A variant with `plugins`, `features` or
 * `drop` fails the build, since those have no Vite equivalent here.
 *
 * `bun run comparison:vite` puts both bundlers side by side in VITE.md.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build, rolldownVersion, version as viteVersion, type InlineConfig, type Rolldown } from 'vite';

// Read by build.ts, check.ts, measure.ts (and check.ts's children), so set it before importing them.
const outFlag = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
const ROOT = import.meta.dir;
process.env.SVELTE_LITE_DIST = outFlag ? resolve(outFlag) : join(ROOT, 'dist-vite');
const DIST = process.env.SVELTE_LITE_DIST;

// build.ts links node_modules/svelte (and refuses a dirty checkout) before anything imports svelte/compiler.
const { APPS, htmlPage, verifyRemovedApi, verifyResolution } = await import('./build.ts');
const { SVELTE_DIR, svelteLabel } = await import('./scripts/link-svelte.ts');
const { viteMetafile, vitePatchPlugin, viteResolutions, viteSveltePlugin } = await import('./plugins/vite.ts');
const { BUILD_FLAGS, flaggedName, resolveVariant, variants } = await import('./variants.ts');
type Variant = import('./variants.ts').Variant;
// acorn comes from the Svelte checkout's node_modules (no extra deps here).
const acorn: any = await import(Bun.resolveSync('acorn', join(SVELTE_DIR, 'src')));

const BUNDLER = `Vite ${viteVersion} (Rolldown ${rolldownVersion})`;

/** The three bundles of build.ts's MODES, in Vite terms. */
const MODES = {
	min: { suffix: '.min', minify: 'oxc', output: {} },
	unmin: { suffix: '', minify: false, output: { minify: false } },
	readable: {
		suffix: '.readable',
		minify: 'oxc',
		output: { minify: { compress: true, mangle: false, codegen: { removeWhitespace: false } } }
	}
} satisfies Record<string, { suffix: string; minify: 'oxc' | false; output: Rolldown.OutputOptions }>;
type Mode = keyof typeof MODES;

/** Options every Vite build here shares: no config file, .env files or public/ dir. */
const BASE: InlineConfig = { configFile: false, root: ROOT, mode: 'production', logLevel: 'warn', envDir: false, publicDir: false };

const outDir = (name: string, app: string) => join(DIST, name, app);

function assertViteable(name: string, variant: Variant) {
	for (const key of ['plugins', 'features', 'drop'] as const) {
		if (variant[key]?.length) throw new Error(`${name}: variant option \`${key}\` is Bun-specific; build-vite.ts has no equivalent`);
	}
}

async function buildClient(name: string, variant: Variant, app: string, mode: Mode, log: string[] = []) {
	const outdir = outDir(name, app);
	const { suffix, minify, output } = MODES[mode];
	const resolutions = {};
	await build({
		...BASE,
		define: variant.define,
		plugins: [
			viteResolutions(resolutions),
			vitePatchPlugin({ svelteDir: SVELTE_DIR, patches: variant.patches, constImports: variant.constImports, log }),
			viteSveltePlugin({ ...variant.svelte, compilerOptions: variant.compilerOptions }),
			mode === 'unmin' && viteMetafile(join(outdir, 'meta.unmin.json'))
		],
		build: {
			outDir: outdir,
			emptyOutDir: false,
			minify,
			reportCompressedSize: false,
			rolldownOptions: {
				input: join(ROOT, 'apps', app, 'client.js'),
				output: { entryFileNames: `main${suffix}.js`, assetFileNames: `main${suffix}.[ext]`, ...output }
			}
		}
	});
	verifyResolution({ inputs: resolutions }, `${name}/${app}/${mode} (vite)`);
	if (mode === 'readable') {
		const file = join(outdir, 'main.readable.js');
		await Bun.write(file, markModules(readFileSync(join(outdir, 'main.js'), 'utf8'), readFileSync(file, 'utf8')));
	}
}

/** Names a top-level statement declares. */
function declared(node: any): string[] {
	if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return [node.id.name];
	if (node.type === 'VariableDeclaration') return node.declarations.filter((d: any) => d.id.type === 'Identifier').map((d: any) => d.id.name);
	return [];
}

/** The module a top-level statement belongs to: for a `var` list, the one with the most bytes in it. */
function owner(node: any, moduleOf: Map<string, string>): string | undefined {
	if (node.type !== 'VariableDeclaration') return declared(node).map((name) => moduleOf.get(name)).find(Boolean);
	const bytes = new Map<string, number>();
	for (const d of node.declarations) {
		const module = d.id.type === 'Identifier' && moduleOf.get(d.id.name);
		if (module) bytes.set(module, (bytes.get(module) ?? 0) + d.end - d.start);
	}
	return [...bytes].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/**
 * The `// <path>` module markers measure.ts attributes bytes by. Oxc's compress pass merges `var`
 * lists across modules and drops most of Rolldown's `//#region` comments, so they are recovered
 * from main.js (unminified: same scope hoisting and names, every region intact): each readable
 * statement belongs to the module that declares its names; a merged `var` list (e.g. render.js's
 * `mounted_components` + branches.js's `BranchManager` class) to the module with the most bytes in
 * it; a statement that declares nothing (a top-level call) stays with the one before it.
 */
function markModules(unmin: string, readable: string): string {
	const comments: any[] = [];
	const unminAst = acorn.parse(unmin, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments });
	const regions = comments.filter((c) => c.type === 'Line' && c.value.startsWith('#region ')).map((c) => ({ pos: c.start, path: c.value.slice(8).trim() }));
	const moduleOf = new Map<string, string>();
	let r = -1;
	for (const node of unminAst.body) {
		while (r + 1 < regions.length && regions[r + 1].pos < node.start) r++;
		if (r >= 0) for (const name of declared(node)) moduleOf.set(name, regions[r].path);
	}

	readable = readable.replace(/^\/\/#(region|endregion)\b.*\n/gm, '');
	let out = '';
	let pos = 0;
	let current = '';
	for (const node of acorn.parse(readable, { ecmaVersion: 'latest', sourceType: 'module' }).body) {
		const module = owner(node, moduleOf);
		if (!module || module === current) continue;
		const line = readable.lastIndexOf('\n', node.start - 1) + 1;
		out += `${readable.slice(pos, line)}// ${module}\n`;
		pos = line;
		current = module;
	}
	return out + readable.slice(pos);
}

/** SSR: a Vite SSR build of apps/<app>/server.js (unpatched server runtime), rendered into index.html. */
async function buildHtml(name: string, variant: Variant, app: string) {
	const outdir = outDir(name, app);
	const ssrDir = join(outdir, '.ssr');
	const out = (await build({
		...BASE,
		plugins: [viteSveltePlugin({ generate: 'server', compilerOptions: variant.compilerOptions })],
		ssr: { noExternal: true },
		build: { ssr: join(ROOT, 'apps', app, 'server.js'), outDir: ssrDir, emptyOutDir: true, minify: false }
	})) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
	const entry = [out].flat()[0].output[0].fileName;
	const mod = await import(`${join(ssrDir, entry)}?v=${Date.now()}`);
	const { head, body } = mod.render(mod.App);
	rmSync(ssrDir, { recursive: true, force: true });
	await Bun.write(join(outdir, 'index.html'), htmlPage(`svelte-lite: ${app} (${name}, vite)`, head, body));
}

async function buildApp(name: string, variant: Variant, app: string) {
	const outdir = outDir(name, app);
	rmSync(outdir, { recursive: true, force: true });
	mkdirSync(outdir, { recursive: true });
	const log: string[] = [];
	for (const mode of Object.keys(MODES) as Mode[]) {
		await buildClient(name, variant, app, mode, mode === 'min' ? log : []);
	}
	verifyRemovedApi(variant, await Bun.file(join(outdir, 'main.readable.js')).text(), `${name}/${app} (vite)`);
	if (variant.postpass) log.push('post-pass: skipped (Bun-only: it re-bundles with Bun)');
	await buildHtml(name, variant, app);
	await Bun.write(join(outdir, 'patches.log'), [...new Set(log)].join('\n') + '\n');
	return outdir;
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const appFlag = args.find((a) => a.startsWith('--app='))?.slice(6);
let names = args.filter((a) => !a.startsWith('--'));
if (flags.has('--all')) names = Object.keys(variants);
if (names.length === 0) names = ['baseline'];
const buildFlags = Object.keys(BUILD_FLAGS).filter((f) => flags.has(`--${f}`));
names = names.map((n) => {
	const [base, ...own] = n.split('+');
	return flaggedName(base, [...own, ...buildFlags]);
});
const apps = appFlag ? [appFlag] : APPS;

const { measure } = await import('./measure.ts');
const { check } = await import('./check.ts');
console.log(`building with ${svelteLabel()} and ${BUNDLER} -> ${relative(ROOT, DIST) || '.'}/`);

const n = (x: number) => x.toLocaleString('en-US');
for (const name of names) {
	const variant = resolveVariant(name);
	if (!variant) {
		console.error(`unknown variant "${name}". known: ${Object.keys(variants).join(', ')}; flags: ${Object.keys(BUILD_FLAGS).map((f) => `--${f}`).join(', ')}`);
		process.exit(1);
	}
	assertViteable(name, variant);
	for (const app of apps) {
		const t0 = performance.now();
		const outdir = await buildApp(name, variant, app);
		console.log(`\n=== ${name}/${app} (vite) === (${(performance.now() - t0).toFixed(0)} ms) ${variant.description}`);
		if (!flags.has('--no-check')) await check(name, app);
		const r = await measure(name, app, outdir, { bundler: BUNDLER });
		const s = r.sizes['main.min.js'];
		// the Bun build of the same variant/app, if there is one
		const bunReport = join(ROOT, 'dist', name, app, 'report.json');
		const bun = existsSync(bunReport) ? JSON.parse(readFileSync(bunReport, 'utf8')) : null;
		const vs = bun
			? ` (Bun: ${n(bun.sizes['main.min.js'].raw)} / ${n(bun.sizes['main.min.js'].gzip)} / ${n(bun.sizes['main.min.js'].brotli)}` +
				(bun.svelte?.sha !== r.svelte.sha ? `, built from other Svelte ${bun.svelte?.sha?.slice(0, 12) ?? '?'}` : '') +
				')'
			: '';
		console.log(`main.min.js: ${n(s.raw)} B raw / ${n(s.gzip)} gzip / ${n(s.brotli)} brotli${vs}`);
	}
}
console.log(`\nbuilt ${names.join(', ')} with ${svelteLabel()} and ${BUNDLER}`);
