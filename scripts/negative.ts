#!/usr/bin/env bun
/**
 * Negative tests: features removed in `minimal` must fail loudly, not break silently.
 *
 *   bun scripts/negative.ts [variant]   (default: minimal)
 *
 * Build-time: each tests/negative/*.svelte component is bundled with the variant's client
 * config and must FAIL with a clear message (and must build with `baseline`, unless the
 * feature is invalid in vanilla Svelte too, e.g. template `await` without experimental.async).
 * Runtime: the stubbed public APIs (fork, settled) must throw a "svelte-lite: ..." error.
 */
import { join, resolve } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { ROOT, SVELTE_DIR, ensureSvelteLink } from './link-svelte.ts';

ensureSvelteLink();
const { variants } = await import('../variants.ts');
const { sveltePlugin } = await import('../plugins/svelte.ts');
const { patchPlugin } = await import('../plugins/patch.ts');

const variantName = process.argv[2] ?? 'minimal';
const tmp = join(resolve(ROOT, process.env.SVELTE_LITE_DIST ?? 'dist'), '.negative'); // build.ts/check.ts --out=<dir>

/** component -> [expected error in the variant, builds in baseline?] */
const BUILD_CASES: Record<string, [RegExp, boolean]> = {
	'Legacy.svelte': [/runes mode|export let|\$:/i, true],
	'Transition.svelte': [/svelte-lite: transition/, true],
	'Animate.svelte': [/svelte-lite: animate/, true],
	'Await.svelte': [/experimental\.async|experimental_async/i, false],
	'BoundaryPending.svelte': [/svelte-lite: <svelte:boundary> `pending`/, true],
	'EffectPending.svelte': [/svelte-lite: \$effect\.pending/, true]
};

const RUNTIME_CASES: Record<string, [string, RegExp]> = {
	'fork()': [`import { fork } from 'svelte'; fork(() => {});`, /svelte-lite: fork\(\) is not supported/],
	'settled()': [`import { settled } from 'svelte'; settled();`, /svelte-lite: settled\(\) is not supported/]
};

async function build(variant: string, entry: string) {
	const v = variants[variant];
	const r = await Bun.build({
		entrypoints: [entry],
		outdir: join(tmp, variant),
		target: 'browser',
		conditions: ['browser', 'production'],
		define: { 'process.env.NODE_ENV': '"production"' },
		optimizeImports: v.optimizeImports ?? [],
		throw: false,
		plugins: [
			patchPlugin({ svelteDir: SVELTE_DIR, patches: v.patches, constImports: v.constImports }),
			sveltePlugin({ ...v.svelte, compilerOptions: v.compilerOptions })
		]
	}).catch((e) => ({ success: false, logs: [e], outputs: [] }) as any);
	const message = r.success ? '' : r.logs.map((l: any) => l?.message ?? String(l)).join('\n');
	return { ok: r.success, message, outputs: r.outputs };
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
let failed = 0;
const rows: string[] = [];

for (const [file, [expected, validInBaseline]] of Object.entries(BUILD_CASES)) {
	const entry = join(tmp, `${file}.entry.js`);
	await Bun.write(entry, `import C from ${JSON.stringify(join(ROOT, 'tests/negative', file))};\nconsole.log(C);\n`);
	const base = await build('baseline', entry);
	const lite = await build(variantName, entry);
	const firstLine = lite.message.split('\n').find((l: string) => l.trim()) ?? '';
	const pass = !lite.ok && expected.test(lite.message) && base.ok === validInBaseline;
	if (!pass) failed++;
	rows.push(`${pass ? 'ok  ' : 'FAIL'} build   ${file.padEnd(24)} baseline: ${base.ok ? 'builds' : 'fails'}; ${variantName}: ${lite.ok ? 'BUILDS (expected failure)' : `fails: ${firstLine.slice(0, 140)}`}`);
}

for (const [name, [src, expected]] of Object.entries(RUNTIME_CASES)) {
	const entry = join(tmp, `${name.replace(/\W/g, '')}.entry.js`);
	await Bun.write(entry, src);
	const lite = await build(variantName, entry);
	let error = '';
	if (lite.ok) {
		const proc = Bun.spawnSync(['bun', lite.outputs[0].path], { stdout: 'pipe', stderr: 'pipe' });
		error = proc.stderr.toString() + proc.stdout.toString();
	}
	const pass = lite.ok && expected.test(error);
	if (!pass) failed++;
	rows.push(`${pass ? 'ok  ' : 'FAIL'} runtime ${name.padEnd(24)} ${variantName}: ${(error.match(/svelte-lite:[^\n]*/)?.[0] ?? (lite.ok ? 'no error thrown' : lite.message)).slice(0, 140)}`);
}

rmSync(tmp, { recursive: true, force: true });
console.log(rows.join('\n'));
if (failed) {
	console.error(`${failed} negative test(s) FAILED`);
	process.exit(1);
}
