#!/usr/bin/env bun
/**
 * Run Svelte's official test suite against a patched variant and report regressions
 * relative to unpatched Svelte.
 *
 *   bun run test:svelte <variant> [--suite=runtime-runes,hydration] [--filter=<sample>]
 *                                 [--without=PROXY,DELEGATION] [--async=on|off] [--fresh]
 *                                 [--with-dev-const] [--mutate=<name>]
 *   bun run test:svelte --report   regenerate SVELTE_TESTS.md from the existing dist/<variant>/svelte-tests*.json
 *
 * How it works (nothing under the Svelte checkout is ever written):
 *  1. Two disposable copies of the Svelte monorepo under .cache/svelte-test/: `reference`
 *     (unpatched) and `<variant>[--without-X]`. Copied without .git/node_modules/_output;
 *     node_modules are real directories whose entries link into the checkout's pnpm
 *     node_modules, so Vite/Vitest caches and temp files land in the copy.
 *  2. The variant copy's client runtime (packages/svelte/src, minus compiler/server) is
 *     rewritten with the *same* patch definitions and applyPatches() the build uses
 *     (plugins/patch.ts), except:
 *       - DEV_CONST is never applied: it hard-codes DEV = false, but the suite runs most
 *         tests with the dev runtime (esm-env resolves DEV = true under vitest), and
 *         runtime-production mocks esm-env to DEV = false itself. So production paths are
 *         still exercised, by the suite's own mechanism.
 *       - techniques listed in --without (for bisecting).
 *  3. Compile-time transforms: the suite compiles components itself, so the copy's compiler
 *     gets a thin post-processing hook that runs plugins/transform-compiled.js (the same
 *     module the Bun plugin uses) on client output. Only `proxySet` is applied (needed
 *     because the patched set() no longer proxies); the build-time bans are not enforced,
 *     tests using dropped features fail and are classified as expected.
 *  4. The official vitest config runs from each copy's root (node + the checkout's vitest),
 *     JSON reporter. Reference results are cached per (svelte sha, async mode, suite, filter).
 *  5. Failures that pass on the reference are classified (expected: the sample uses a
 *     dropped feature, detected statically from its sources + compiled output; otherwise
 *     UNEXPECTED). Writes dist/<variant>/svelte-tests.json and regenerates SVELTE_TESTS.md.
 *     Exit code 1 if there are unexpected regressions.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import * as link from './link-svelte.ts';

const ROOT = link.ROOT;
const L: any = link;
const SVELTE_DIR: string = L.SVELTE_DIR;
const SVELTE_REPO: string = L.SVELTE_REPO ?? resolve(SVELTE_DIR, '../..');
const CACHE = join(ROOT, '.cache', 'svelte-test');

const { variants } = await import('../variants.ts');
const { applyPatches } = await import('../plugins/patch.ts');
const OPT = await import('../patches/optimized.ts');
const MIN = await import('../patches/minimal.ts');

const TECHNIQUES: Record<string, any> = {
	DEV_CONST: OPT.DEV_CONST,
	NAMED_IMPORTS: OPT.NAMED_IMPORTS,
	PURE: OPT.PURE,
	DISCLOSE: OPT.DISCLOSE,
	LEGACY: MIN.LEGACY,
	ASYNC: MIN.ASYNC,
	TRANSITIONS: MIN.TRANSITIONS,
	ROOT_BOUNDARY: MIN.ROOT_BOUNDARY,
	DELEGATION: MIN.DELEGATION,
	PROXY: MIN.PROXY
};

export const SUITES: Record<string, string> = {
	'runtime-runes': 'packages/svelte/tests/runtime-runes/test.ts',
	'runtime-legacy': 'packages/svelte/tests/runtime-legacy/test.ts',
	'runtime-production': 'packages/svelte/tests/runtime-production/test.ts',
	'runtime-xhtml': 'packages/svelte/tests/runtime-xhtml/test.ts',
	hydration: 'packages/svelte/tests/hydration/test.ts',
	signals: 'packages/svelte/tests/signals/test.ts',
	store: 'packages/svelte/tests/store/test.ts',
	motion: 'packages/svelte/tests/motion/test.ts',
	'runtime-browser': 'packages/svelte/tests/runtime-browser/test.ts',
	unit: 'packages/svelte/src/'
};

// ---------------------------------------------------------------------------------------------
// args

const argv = process.argv.slice(2);
const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (argv.includes('--report')) {
	// regenerate SVELTE_TESTS.md from existing dist/*/svelte-tests*.json, run nothing
	await writeMarkdown();
	console.log('wrote SVELTE_TESTS.md');
	process.exit(0);
}
const variantName = argv.find((a) => !a.startsWith('--'));
if (!variantName || !variants[variantName]) {
	console.error(`usage: bun run test:svelte <variant> [--suite=a,b] [--filter=x] [--without=T1,T2] [--async=on|off] [--fresh]\nvariants: ${Object.keys(variants).join(', ')}`);
	process.exit(2);
}
const variant = variants[variantName];
const without = (flag('without') ?? '').split(',').filter(Boolean);
for (const t of without) if (!TECHNIQUES[t]) throw new Error(`unknown technique ${t}; known: ${Object.keys(TECHNIQUES).join(', ')}`);
const usesTechnique = (t: string) =>
	(TECHNIQUES[t].patches ?? []).some((p: any) => variant.patches?.includes(p)) ||
	(TECHNIQUES[t].constImports ?? []).some((c: any) => variant.constImports?.includes(c)) ||
	(t === 'PROXY' && !!variant.svelte?.proxySet);
const dropsAsync = usesTechnique('ASYNC') && !without.includes('ASYNC');
// async mode: the suite compiles runes tests with experimental.async unless SVELTE_NO_ASYNC=true
// (the official CI runs both). A variant without async can only be compared in no-async mode.
const defaultAsync = dropsAsync ? 'off' : 'on';
const asyncMode = (flag('async') ?? defaultAsync) as 'on' | 'off';
const suites = (flag('suite') ?? Object.keys(SUITES).join(',')).split(',').filter(Boolean);
for (const s of suites) if (!SUITES[s]) throw new Error(`unknown suite ${s}; known: ${Object.keys(SUITES).join(', ')}`);
const filter = flag('filter');
const fresh = argv.includes('--fresh');
// --with-dev-const: also apply DEV_CONST (DEV = false everywhere). Only meaningful for the
// suites that run the production runtime anyway (runtime-production, runtime-browser); it tests
// the exact shipped combination there.
const withDevConst = argv.includes('--with-dev-const');
// --mutate=<name>: harness self-check. Deliberately break one risky patch after patching and
// confirm the suite reports UNEXPECTED regressions (i.e. the suite really exercises it).
const MUTATIONS: Record<string, { why: string; file?: string; find?: string; replace?: string }> = {
	'no-proxy-hook': { why: 'runtime proxy patches applied, compiled $.set(x, v, true) NOT rewritten' },
	'no-hydrate-next': {
		why: 'root-boundary patch without the hydrate_next() that consumes the SSR open marker',
		file: 'src/internal/client/render.js',
		find: 'if (hydrating) hydrate_next();',
		replace: ''
	},
	'no-delegation-install': {
		why: 'lazy delegation without installing the root-listener hook in delegate()',
		file: 'src/internal/client/dom/elements/events.js',
		find: 'delegation ??= { register, unregister };',
		replace: ''
	}
};
const mutate = flag('mutate');
if (mutate && !MUTATIONS[mutate]) throw new Error(`unknown mutation ${mutate}; known: ${Object.keys(MUTATIONS).join(', ')}`);
const label =
	variantName +
	without.map((t) => `--without-${t}`).join('') +
	(withDevConst ? '--with-dev-const' : '') +
	(mutate ? `--mutate-${mutate}` : '');

// runtime-browser needs a Playwright Chromium the checkout's playwright-core can launch
// (headless uses chromium-headless-shell, so just try launching it)
function playwrightAvailable() {
	mkdirSync(CACHE, { recursive: true });
	const res = spawnSync(
		'node',
		['-e', "require('playwright').chromium.launch().then((b) => b.close()).then(() => console.log('ok'), () => console.log('no'))"],
		{ cwd: CACHE, encoding: 'utf8', env: { ...process.env, NODE_PATH: join(SVELTE_REPO, 'node_modules') }, timeout: 60_000 }
	);
	return res.stdout.trim() === 'ok';
}
if (suites.includes('runtime-browser') && !playwrightAvailable()) {
	console.warn('runtime-browser: skipped (no Playwright Chromium installed for the checkout)');
	suites.splice(suites.indexOf('runtime-browser'), 1);
}

// ---------------------------------------------------------------------------------------------
// svelte identity (cache key)

function git(...args: string[]) {
	// --no-optional-locks: `git status` must not refresh (write) the checkout's index
	const r = spawnSync('git', ['--no-optional-locks', '-C', SVELTE_REPO, ...args], { encoding: 'utf8' });
	return r.status === 0 ? r.stdout.trim() : null;
}
function svelteSha(): string {
	const info = L.SVELTE_REF ?? L.svelteRef ?? L.SVELTE_INFO;
	let sha: string | null = info?.sha ?? L.SVELTE_SHA ?? git('rev-parse', 'HEAD');
	if (!sha) sha = `v${JSON.parse(readFileSync(join(SVELTE_DIR, 'package.json'), 'utf8')).version}`;
	// uncommitted changes to the package invalidate the cache too
	const dirty = git('status', '--porcelain', '--', 'packages/svelte', 'vitest.config.js');
	if (dirty) sha += `-dirty-${Bun.hash(git('diff', 'HEAD', '--', 'packages/svelte') ?? dirty).toString(16)}`;
	return sha;
}
const SHA = svelteSha();

// ---------------------------------------------------------------------------------------------
// disposable copies

// dot-entries of node_modules are tool caches (.vite, .vite-temp, .cache, …): never link them,
// or Vite/Vitest would write into the checkout through the link
const LINKED_DOT_ENTRIES = new Set(['.pnpm', '.bin', '.modules.yaml', '.pnpm-workspace-state-v1.json']);

function linkNodeModules(from: string, to: string) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from)) {
		if (entry.startsWith('.') && !LINKED_DOT_ENTRIES.has(entry)) continue;
		const src = join(from, entry);
		const dst = join(to, entry);
		if (existsSync(dst) || lstatSync(dst, { throwIfNoEntry: false })) continue;
		const st = lstatSync(src);
		// relative symlinks (pnpm links, workspace links like svelte -> ../packages/svelte) are
		// replicated verbatim so they resolve inside the copy; real dirs are linked absolutely
		if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), dst);
		else symlinkSync(src, dst);
	}
}

function makeCopy(name: string) {
	const dir = join(CACHE, name);
	mkdirSync(dir, { recursive: true });
	const excludes = ['.git', 'node_modules', '_output', '_actual*', 'coverage', 'playgrounds', 'documentation', 'benchmarking', '.cache'];
	const r = spawnSync(
		'rsync',
		['-a', '--delete', ...excludes.flatMap((e) => ['--exclude', e]), `${SVELTE_REPO}/`, `${dir}/`],
		{ encoding: 'utf8' }
	);
	if (r.status !== 0) throw new Error(`rsync failed: ${r.stderr}`);
	rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
	rmSync(join(dir, 'packages/svelte/node_modules'), { recursive: true, force: true });
	linkNodeModules(join(SVELTE_REPO, 'node_modules'), join(dir, 'node_modules'));
	linkNodeModules(join(SVELTE_DIR, 'node_modules'), join(dir, 'packages/svelte/node_modules'));
	return dir;
}

function runtimeFiles(pkg: string): string[] {
	const out: string[] = [];
	(function walk(d: string) {
		for (const f of readdirSync(d)) {
			const p = join(d, f);
			if (statSync(p).isDirectory()) {
				if (f !== 'compiler' && f !== 'server') walk(p);
			} else if (f.endsWith('.js') && !f.includes('.test.') && !/-server\.js$/.test(f)) out.push(p);
		}
	})(join(pkg, 'src'));
	return out;
}

/** Apply the variant's patches (same definitions + applyPatches as the build) to the copy. */
async function patchCopy(dir: string) {
	const pkg = join(dir, 'packages/svelte');
	const skip = new Set([...(withDevConst ? [] : ['DEV_CONST']), ...without]);
	const skipPatches = new Set([...skip].flatMap((t) => TECHNIQUES[t].patches ?? []));
	const skipConsts = new Set([...skip].flatMap((t) => TECHNIQUES[t].constImports ?? []));
	const patches = (variant.patches ?? []).filter((p: any) => !skipPatches.has(p));
	const constImports = (variant.constImports ?? []).filter((c: any) => !skipConsts.has(c));
	const log: string[] = [];
	for (const file of runtimeFiles(pkg)) {
		const original = readFileSync(file, 'utf8');
		const { code, applied } = await applyPatches(file, original, { svelteDir: pkg, patches, constImports });
		if (code !== original) {
			writeFileSync(file, code);
			for (const a of applied) log.push(`${a.file}: [${a.feature}] ${a.why}`);
		}
	}

	// compiler hook: same compiled-output transform as plugins/svelte.ts (proxySet only)
	const proxySet = !!variant.svelte?.proxySet && !skip.has('PROXY') && mutate !== 'no-proxy-hook';
	if (proxySet) {
		const index = join(pkg, 'src/compiler/index.js');
		let src = readFileSync(index, 'utf8');
		const anchors: Array<[string, string]> = [
			['const result = transform_component(analysis, source, combined_options);', 'const result = transform_component(analysis, source, combined_options);\n\t__svelte_lite_post(result, combined_options.generate, options.filename);'],
			['return transform_module(analysis, source, validated);', 'const result = transform_module(analysis, source, validated);\n\t__svelte_lite_post(result, validated.generate, options.filename);\n\treturn result;']
		];
		for (const [a, b] of anchors) {
			if (src.split(a).length !== 2) throw new Error(`[svelte-tests] compiler hook anchor not found: ${a}`);
			src = src.replace(a, b);
		}
		src = `import { __svelte_lite_post } from './svelte-lite-hook.js';\n${src}`;
		writeFileSync(index, src);
		writeFileSync(
			join(pkg, 'src/compiler/svelte-lite-hook.js'),
			`// svelte-lite test harness: apply the build's compiled-output transform to client output
import * as acorn from 'acorn';
import MagicString from 'magic-string';
import { transformCompiled } from ${JSON.stringify(join(ROOT, 'plugins/transform-compiled.js'))};
const opts = ${JSON.stringify({ proxySet: true })};
export function __svelte_lite_post(result, generate, filename) {
	if (generate !== 'client' || !result?.js?.code) return;
	result.js.code = transformCompiled(result.js.code, filename ?? '(unknown)', opts, { acorn, MagicString });
}
`
		);
		log.push('src/compiler/index.js: [harness] client output post-processed with plugins/transform-compiled.js (proxySet)');
	}
	const m = mutate ? MUTATIONS[mutate] : null;
	if (m?.file) {
		const f = join(pkg, m.file);
		const src = readFileSync(f, 'utf8');
		if (src.split(m.find!).length !== 2) throw new Error(`[svelte-tests] mutation ${mutate}: anchor not found in ${m.file}`);
		writeFileSync(f, src.replace(m.find!, m.replace!));
	}
	if (m) log.push(`[mutation ${mutate}] ${m.why}`);
	writeFileSync(join(dir, 'svelte-lite-patches.log'), [...new Set(log)].join('\n') + '\n');
	return log;
}

// ---------------------------------------------------------------------------------------------
// vitest

interface Result {
	id: string;
	suite: string;
	file: string;
	name: string;
	status: 'passed' | 'failed' | 'skipped';
	message?: string;
}

function suiteOf(file: string) {
	return Object.entries(SUITES).find(([, p]) => (p.endsWith('/') ? file.startsWith(p) : file === p))?.[0] ?? 'other';
}

function runVitest(dir: string, suiteList: string[], out: string, tag: string): Promise<Result[]> {
	return new Promise((resolvePromise, reject) => {
		const vitest = join(dir, 'node_modules/vitest/vitest.mjs');
		const args = [vitest, 'run', '--reporter=json', `--outputFile=${out}`, '--passWithNoTests', ...suiteList.map((s) => SUITES[s])];
		const env = { ...process.env, SVELTE_NO_ASYNC: asyncMode === 'off' ? 'true' : '', FILTER: filter ?? '', CI: '' };
		if (!filter) delete (env as any).FILTER;
		if (asyncMode === 'on') delete (env as any).SVELTE_NO_ASYNC;
		const t0 = performance.now();
		const child = spawn('node', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stderr = '';
		child.stderr.on('data', (d) => (stderr += d));
		child.stdout.on('data', () => {});
		child.on('close', (code) => {
			const secs = ((performance.now() - t0) / 1000).toFixed(0);
			if (!existsSync(out)) return reject(new Error(`[${tag}] vitest produced no report (exit ${code})\n${stderr.slice(-3000)}`));
			console.log(`[${tag}] vitest done in ${secs}s (exit ${code})`);
			const json = JSON.parse(readFileSync(out, 'utf8'));
			const results: Result[] = [];
			for (const f of json.testResults ?? []) {
				const file = relative(dir, f.name);
				const fileFailed = f.status === 'failed';
				for (const a of f.assertionResults ?? []) {
					const name = [...(a.ancestorTitles ?? []), a.title].filter(Boolean).join(' > ');
					const status = a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped';
					results.push({
						id: `${file} :: ${name}`,
						suite: suiteOf(file),
						file,
						name,
						status,
						message:
							status === 'failed'
								? (a.failureMessages ?? []).join('\n').slice(0, 1500)
								: status === 'skipped' && fileFailed
									? `skipped: a hook in this file failed${f.message ? `: ${String(f.message).slice(0, 500)}` : ''}`
									: undefined
					});
				}
				// a test file that fails to load has no assertions: record it as one failure
				if (!(f.assertionResults ?? []).length && f.status === 'failed') {
					results.push({ id: `${file} :: (file)`, suite: suiteOf(file), file, name: '(file failed to load)', status: 'failed', message: String(f.message ?? '').slice(0, 1500) });
				}
			}
			resolvePromise(results);
		});
		child.on('error', reject);
	});
}

// ---------------------------------------------------------------------------------------------
// classification: does the sample use a feature the variant drops?

const DROPPED: Record<string, string[]> = {
	LEGACY: ['legacy'],
	ASYNC: ['async'],
	TRANSITIONS: ['transitions'],
	ROOT_BOUNDARY: ['root-boundary']
};

function readAll(dir: string, pred: (f: string) => boolean): string {
	if (!existsSync(dir)) return '';
	let text = '';
	(function walk(d: string) {
		for (const f of readdirSync(d)) {
			const p = join(d, f);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (pred(p)) text += `\n/* ${relative(dir, p)} */\n` + readFileSync(p, 'utf8');
		}
	})(dir);
	return text;
}

function sampleDir(r: Result, copy: string): string | null {
	const m = r.file.match(/^packages\/svelte\/tests\/([^/]+)\/test\.ts$/);
	if (!m) return null;
	const first = r.name.split(' > ').at(-1)!.replace(/ \((dom|hydrate|ssr|async-ssr)\)$/, '');
	for (const samples of ['samples', 'custom-elements-samples']) {
		const d = join(copy, 'packages/svelte/tests', m[1], samples, first);
		if (existsSync(d)) return d;
	}
	return null;
}

/** Feature reasons for a failing test, given the reference copy (sources + its compiled output). */
function detectFeatures(r: Result, refCopy: string): Array<{ feature: string; reason: string }> {
	const out: Array<{ feature: string; reason: string }> = [];
	const add = (feature: string, reason: string) => out.push({ feature, reason });
	const dir = sampleDir(r, refCopy);
	if (r.suite === 'runtime-legacy') add('legacy', 'runtime-legacy suite: non-runes components (createClassComponent, legacy mode)');
	// the test ran into one of the variant's "svelte-lite: … is not supported" stubs
	const stub = r.message?.match(/svelte-lite: ([^\n]*?) is not supported/);
	if (stub) add(/legacy/.test(stub[1]) ? 'legacy' : 'async', `hit the svelte-lite stub for ${stub[1]}`);
	// test files (not samples) whose hooks switch async/legacy mode on: their tests are skipped
	// when the hook throws
	if (r.status === 'skipped' && !dir) {
		const src = readFileSync(join(refCopy, r.file), 'utf8');
		if (/enable_async_mode_flag\(\)/.test(src)) add('async', 'test file enables async mode in a hook (enable_async_mode_flag() throws)');
		if (/enable_legacy_mode_flag\(\)/.test(src)) add('legacy', 'test file enables legacy mode in a hook');
	}
	if (!dir) return out.filter((x, i) => out.findIndex((y) => y.feature === x.feature && y.reason === x.reason) === i);
	const src = readAll(dir, (p) => !p.includes('/_output/') && /\.(svelte|js|ts)$/.test(p));
	const compiled = readAll(join(dir, '_output', 'client'), (p) => p.endsWith('.js'));
	const config = existsSync(join(dir, '_config.js')) ? readFileSync(join(dir, '_config.js'), 'utf8') : '';

	// legacy mode
	if (/svelte\/internal\/flags\/legacy/.test(compiled)) add('legacy', 'compiled output enables legacy mode (non-runes component)');
	if (/runes:\s*false/.test(config) || /<svelte:options[^>]*runes=\{false\}/.test(src)) add('legacy', 'sample opts out of runes');
	if (/from ['"]svelte\/legacy['"]/.test(src) || /createClassComponent|asClassComponent/.test(src)) add('legacy', 'uses svelte/legacy (Svelte 4 component API)');
	if (/\$\.legacy_pre_effect|\$\.mutable_source|\$\.init\(/.test(compiled)) add('legacy', 'compiled output uses legacy runtime helpers');

	// async
	if (/svelte\/internal\/flags\/async/.test(compiled)) add('async', 'compiled with experimental.async');
	if (/\$\.(async|async_derived|save|run|track_reactivity_loss|pending|run_after_blockers)\b/.test(compiled)) add('async', 'compiled output uses async runtime ($.async/$.save/$.pending/…)');
	if (/experimental:\s*\{[^}]*async\s*:\s*true/.test(config)) add('async', 'experimental.async in _config.js');
	if (/\$effect\.pending/.test(src)) add('async', '$effect.pending');
	if (/\bfork\s*\(/.test(src) && /import[^;]*\bfork\b[^;]*from ['"]svelte['"]/.test(src)) add('async', 'fork()');
	if (/\bsettled\s*\(/.test(src) && /import[^;]*\bsettled\b[^;]*from ['"]svelte['"]/.test(src)) add('async', 'settled()');
	if (/\$\.boundary\([^;]*pending\s*:/.test(compiled) || /<svelte:boundary[^>]*pending|\{#snippet pending/.test(src)) add('async', '<svelte:boundary> with pending');
	if (/hydratable/.test(src)) add('async', 'hydratable() (async SSR data)');

	// transitions / animations
	if (/\$\.(transition|animation)\(/.test(compiled)) add('transitions', 'compiled output uses transition:/in:/out:/animate:');
	if (/outro:\s*true/.test(src)) add('transitions', 'unmount/$destroy with { outro: true }');
	if (/\bintro:\s*true/.test(config)) add('transitions', 'mount/hydrate with intro: true');

	// root boundary
	if (/transformError/.test(config)) add('root-boundary', 'mount/hydrate transformError option');

	// dedupe
	return out.filter((x, i) => out.findIndex((y) => y.feature === x.feature && y.reason === x.reason) === i);
}

// ---------------------------------------------------------------------------------------------
// main

const t0 = performance.now();
mkdirSync(CACHE, { recursive: true });
const STAMP = join(CACHE, '.run-stamp');
writeFileSync(STAMP, String(Date.now()));
console.log(`svelte ${SHA} @ ${SVELTE_REPO}`);
console.log(`variant ${label}: suites ${suites.join(', ')}; async mode ${asyncMode}${filter ? `; FILTER=${filter}` : ''}`);

const refKey = (s: string) => join(CACHE, 'reference-results', SHA, `async-${asyncMode}`, `${s}${filter ? `__${filter.replace(/\W+/g, '_')}` : ''}.json`);
const missing = suites.filter((s) => fresh || !existsSync(refKey(s)));

// one reference copy per async mode (its _output/ is also what the classifier reads)
const refName = `reference-async-${asyncMode}`;
const refCopy = join(CACHE, refName);
const jobs: Array<Promise<void>> = [];
let reference: Result[] = [];
let actual: Result[] = [];

if (missing.length || !existsSync(refCopy)) {
	console.log(`reference: preparing unpatched copy (${missing.length ? `running ${missing.join(', ')}` : 'sources only'})`);
	makeCopy(refName);
}
if (missing.length) {
	jobs.push(
		runVitest(refCopy, missing, join(refCopy, 'svelte-lite-report.json'), 'reference').then((results) => {
			for (const s of missing) {
				mkdirSync(dirname(refKey(s)), { recursive: true });
				writeFileSync(refKey(s), JSON.stringify(results.filter((r) => r.suite === s)));
			}
		})
	);
}

console.log(`${label}: preparing patched copy`);
const varCopy = makeCopy(`${label}-async-${asyncMode}`);
const patchLog = await patchCopy(varCopy);
console.log(`${label}: ${patchLog.length} patch applications (log: ${relative(ROOT, join(varCopy, 'svelte-lite-patches.log'))})`);
jobs.push(
	runVitest(varCopy, suites, join(varCopy, 'svelte-lite-report.json'), label).then((results) => {
		actual = results;
	})
);
await Promise.all(jobs);
for (const s of suites) reference.push(...JSON.parse(readFileSync(refKey(s), 'utf8')));

// never write to the checkout: fail if anything in it (outside .git and the pnpm store) is
// newer than the run's start
const written = spawnSync(
	'find',
	[SVELTE_REPO, '-path', join(SVELTE_REPO, '.git'), '-prune', '-o', '-path', join(SVELTE_REPO, 'node_modules/.pnpm'), '-prune', '-o', '-newer', STAMP, '-print'],
	{ encoding: 'utf8' }
).stdout.trim();
if (written) {
	console.error(`ERROR: the run wrote into the Svelte checkout:\n${written}`);
	process.exit(3);
}

// ---------------------------------------------------------------------------------------------
// diff + classify

const refById = new Map(reference.map((r) => [r.id, r]));
const dropped = Object.entries(DROPPED)
	.filter(([t]) => usesTechnique(t) && !without.includes(t))
	.flatMap(([, f]) => f);

const regressions: Array<Result & { expected: boolean; reasons: Array<{ feature: string; reason: string }> }> = [];
const fixed: Result[] = [];
const missingInVariant: string[] = [];
for (const r of actual) {
	const ref = refById.get(r.id);
	if (!ref) continue;
	if (ref.status === 'passed' && r.status !== 'passed') {
		const reasons = detectFeatures(r, refCopy).filter((x) => dropped.includes(x.feature));
		regressions.push({ ...r, expected: reasons.length > 0, reasons });
	} else if (ref.status === 'failed' && r.status === 'passed') fixed.push(r);
}
const actualIds = new Set(actual.map((r) => r.id));
for (const r of reference) if (!actualIds.has(r.id) && r.status === 'passed') missingInVariant.push(r.id);

const counts = (rs: Result[]) => {
	const c: Record<string, { passed: number; failed: number; skipped: number }> = {};
	for (const r of rs) {
		c[r.suite] ??= { passed: 0, failed: 0, skipped: 0 };
		c[r.suite][r.status]++;
	}
	return c;
};

const report = {
	variant: label,
	svelte: SHA,
	asyncMode,
	filter: filter ?? null,
	without,
	skippedTechniques: [...(withDevConst ? [] : ['DEV_CONST (dev-mode tests need DEV from esm-env; runtime-production mocks DEV=false)']), ...without],
	mutation: mutate ? `${mutate}: ${MUTATIONS[mutate].why}` : null,
	droppedFeatures: dropped,
	suites,
	durationSeconds: Math.round((performance.now() - t0) / 1000),
	counts: { reference: counts(reference), variant: counts(actual) },
	unexpected: regressions.filter((r) => !r.expected),
	expected: regressions.filter((r) => r.expected),
	nowPassing: fixed.map((r) => r.id),
	missingInVariant
};
const outDir = join(ROOT, 'dist', label);
mkdirSync(outDir, { recursive: true });
// the variant's natural async mode -> svelte-tests.json; the other one -> svelte-tests.async-<mode>.json
const reportFile = asyncMode === defaultAsync ? 'svelte-tests.json' : `svelte-tests.async-${asyncMode}.json`;
writeFileSync(join(outDir, reportFile), JSON.stringify(report, null, 2));
await writeMarkdown();

console.log(`\n${label}: ${report.unexpected.length} UNEXPECTED regression(s), ${report.expected.length} expected (dropped features), ${fixed.length} now passing, ${missingInVariant.length} missing; ${report.durationSeconds}s`);
for (const s of suites) {
	const a = report.counts.reference[s] ?? { passed: 0, failed: 0, skipped: 0 };
	const b = report.counts.variant[s] ?? { passed: 0, failed: 0, skipped: 0 };
	console.log(`  ${s.padEnd(20)} reference ${a.passed}/${a.failed}/${a.skipped}  ${label} ${b.passed}/${b.failed}/${b.skipped}  (pass/fail/skip)`);
}
for (const r of report.unexpected.slice(0, 40)) console.log(`  UNEXPECTED ${r.id}\n    ${(r.message ?? '').split('\n')[0].slice(0, 200)}`);
process.exit(report.unexpected.length ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// SVELTE_TESTS.md (all variants with a dist/<variant>/svelte-tests.json)

async function writeMarkdown() {
	const reports = readdirSync(join(ROOT, 'dist'))
		.filter((d) => statSync(join(ROOT, 'dist', d)).isDirectory())
		.flatMap((d) => readdirSync(join(ROOT, 'dist', d)).filter((f) => /^svelte-tests(\.async-(on|off))?\.json$/.test(f)).map((f) => join(ROOT, 'dist', d, f)))
		.map((f) => JSON.parse(readFileSync(f, 'utf8')))
		.sort((a, b) => {
			// optimized before minimal; plain before --with-dev-const/--without-*; async on before off
			const rank = (r: any) => [r.variant.startsWith('optimized') ? 0 : 1, r.variant.includes('--') ? 1 : 0, r.asyncMode === 'on' ? 0 : 1];
			const [x, y] = [rank(a), rank(b)];
			return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.variant.localeCompare(b.variant);
		});
	const mutations = reports.filter((r) => r.mutation);
	reports.splice(0, reports.length, ...reports.filter((r) => !r.mutation));
	const md: string[] = ['<!-- generated by scripts/svelte-tests.ts; do not edit below this line by hand -->', ''];
	const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ⏎ ');
	for (const r of reports) {
		md.push(`## \`${r.variant}\` (async mode ${r.asyncMode})`, '');
		md.push(
			`Svelte \`${r.svelte}\` · async mode **${r.asyncMode}** (${r.asyncMode === 'off' ? 'SVELTE_NO_ASYNC=true, as in the official TestNoAsync CI job' : 'suite default: runes tests compiled with experimental.async'}) · ${r.durationSeconds}s · techniques not applied: ${r.skippedTechniques.join('; ')}${r.filter ? ` · FILTER=${r.filter}` : ''}`,
			''
		);
		md.push('| suite | reference pass / fail / skip | variant pass / fail / skip | unexpected | expected |', '| --- | ---: | ---: | ---: | ---: |');
		for (const s of r.suites) {
			const a = r.counts.reference[s] ?? { passed: 0, failed: 0, skipped: 0 };
			const b = r.counts.variant[s] ?? { passed: 0, failed: 0, skipped: 0 };
			const u = r.unexpected.filter((x: any) => x.suite === s).length;
			const e = r.expected.filter((x: any) => x.suite === s).length;
			md.push(`| ${s} | ${a.passed} / ${a.failed} / ${a.skipped} | ${b.passed} / ${b.failed} / ${b.skipped} | ${u ? `**${u}**` : 0} | ${e} |`);
		}
		md.push('');
		md.push(`### Unexpected regressions (${r.unexpected.length})`, '');
		if (!r.unexpected.length) md.push('None.', '');
		else {
			md.push('| test | error |', '| --- | --- |');
			for (const x of r.unexpected) md.push(`| \`${esc(x.id.replace('packages/svelte/tests/', ''))}\` | ${esc((x.message ?? '').split('\n').filter((l: string) => l.trim()).slice(0, 3).join(' ')).slice(0, 400)} |`);
			md.push('');
		}
		md.push(`### Expected failures, by dropped feature (${r.expected.length})`, '');
		if (!r.expected.length) md.push('None.', '');
		const byFeature = new Map<string, any[]>();
		for (const x of r.expected) {
			const f = x.reasons.map((y: any) => y.feature).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join(' + ');
			if (!byFeature.has(f)) byFeature.set(f, []);
			byFeature.get(f)!.push(x);
		}
		for (const [f, xs] of [...byFeature].sort((a, b) => b[1].length - a[1].length)) {
			const reasons = new Map<string, number>();
			for (const x of xs) for (const y of x.reasons) reasons.set(y.reason, (reasons.get(y.reason) ?? 0) + 1);
			md.push(`<details><summary><b>${f}</b>: ${xs.length} test(s)</summary>`, '');
			md.push(`Detected by: ${[...reasons].map(([k, v]) => `${k} (${v})`).join('; ')}`, '');
			const perSuite = new Map<string, number>();
			for (const x of xs) perSuite.set(x.suite, (perSuite.get(x.suite) ?? 0) + 1);
			md.push(`Per suite: ${[...perSuite].map(([k, v]) => `${k} ${v}`).join(', ')}`, '');
			// the whole runtime-legacy suite is one line; list the rest (capped)
			const listed = xs.filter((x) => x.suite !== 'runtime-legacy');
			for (const x of listed.slice(0, 150)) md.push(`- \`${x.id.replace('packages/svelte/tests/', '')}\`: ${x.reasons.map((y: any) => y.reason).join('; ')}`);
			if (listed.length > 150) md.push(`- … ${listed.length - 150} more in \`dist/${r.variant}/svelte-tests*.json\``);
			md.push('', '</details>', '');
		}
		if (r.nowPassing.length) md.push(`Now passing (failed on the reference): ${r.nowPassing.map((i: string) => `\`${i}\``).join(', ')}`, '');
		if (r.missingInVariant.length) md.push(`Present on the reference but not run on the variant: ${r.missingInVariant.length}`, '');
	}
	if (mutations.length) {
		md.push('## Harness self-check (deliberately broken patches)', '');
		md.push('Each run breaks one risky patch on purpose; the suite must report UNEXPECTED regressions.', '');
		md.push('| mutation | suites | unexpected regressions | e.g. |', '| --- | --- | ---: | --- |');
		for (const r of mutations) {
			md.push(`| ${esc(r.mutation)} | ${r.suites.join(', ')} | **${r.unexpected.length}** | ${r.unexpected[0] ? `\`${esc(r.unexpected[0].id.replace('packages/svelte/tests/', ''))}\`` : '(none: the suite does not catch it)'} |`);
		}
		md.push('');
	}
	const out = join(ROOT, 'SVELTE_TESTS.md');
	const existing = existsSync(out) ? readFileSync(out, 'utf8') : '';
	const marker = md[0];
	const head = existing.includes(marker) ? existing.slice(0, existing.indexOf(marker)) : '# SVELTE_TESTS\n\n';
	writeFileSync(out, head + md.join('\n') + '\n');
}
