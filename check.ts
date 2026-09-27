#!/usr/bin/env bun
/**
 * Behavioural check: for every built variant x app x bundle (main.min.js, main.js,
 * main.readable.js), in a fresh happy-dom process:
 *   1. load the SSR output (dist/<variant>/<app>/index.html) into the document,
 *   2. let the app's test grab references to server-rendered nodes (`before`),
 *   3. run the bundle (its entry calls hydrate()),
 *   4. run the app's assertions (`after`): hydration reused the SSR nodes, interactions work,
 *   5. fail on any exception, unhandled rejection, console.warn/error (this includes
 *      Svelte's hydration_mismatch warning) or failed assertion.
 *
 *   bun run check.ts                    every variant/app found in dist/, plus every patch anchor
 *                                       (scripts/patches-doc.ts --check) and the negative tests
 *                                       (scripts/negative.ts)
 *   bun run check.ts minimal [...]      given variants, all apps
 *   bun run check.ts --app=reactive     restrict to one app
 *   bun run check.ts --out=<dir>        check builds made with build.ts --out=<dir> instead of dist/
 *   bun run check.ts --anchors          only verify every patch anchor against the selected Svelte
 *                                       (no build); add --svelte=<ref> to try another vendored ref
 *   --svelte=<ref>                      (any mode) use that vendored Svelte for the patch anchors
 *                                       and negative tests (see scripts/link-svelte.ts)
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
// the harness lives in harness.ts (runtime-neutral: scripts/v8-coverage.ts runs it under Node)
import { harness, type AppTest } from './harness.ts';
export type { AppTest, TestContext } from './harness.ts';
export { harness };

const ROOT = import.meta.dir;
/** Build output root: dist/, or --out=<dir> / SVELTE_LITE_DIST (set by build.ts --out). */
const outFlag = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
if (outFlag) process.env.SVELTE_LITE_DIST = resolve(outFlag);
const DIST = resolve(ROOT, process.env.SVELTE_LITE_DIST ?? 'dist');
const BUNDLES = ['main.min.js', 'main.js', 'main.readable.js'];


/** Child process entry: print the harness result as JSON. */
async function runOne(variant: string, app: string, bundle: string, scenario: 'normal' | 'mismatch') {
	const res = await harness(variant, app, bundle, scenario);
	console.log(JSON.stringify(res));
	process.exit(res.ok ? 0 : 1);
}

export async function check(variant: string, app: string) {
	const dir = join(DIST, variant, app);
	let failed = 0;
	const test: AppTest = (await import(join(ROOT, 'apps', app, 'test.ts'))).default;
	const runs: Array<[string, 'normal' | 'mismatch']> = BUNDLES.map((f) => [f, 'normal']);
	if (test.mismatch) runs.push(['main.min.js', 'mismatch']);
	for (const [f, scenario] of runs) {
		const proc = Bun.spawnSync(['bun', join(ROOT, 'check.ts'), '--one', variant, app, join(dir, f), scenario], {
			env: process.env, // SVELTE_LITE_DIST
			stdout: 'pipe',
			stderr: 'pipe'
		});
		const out = proc.stdout.toString().trim().split('\n').at(-1) ?? '';
		let res: any = {};
		try {
			res = JSON.parse(out);
		} catch {}
		const label = `${variant}/${app}/${f}${scenario === 'mismatch' ? ' (SSR mismatch -> recovery)' : ''}`;
		if (proc.exitCode === 0 && res.ok) {
			console.log(`check ok   ${label}`);
		} else {
			failed++;
			console.error(`check FAIL ${label}\n${JSON.stringify(res, null, 2)}\n${proc.stderr.toString().slice(-2000)}`);
		}
	}
	if (failed) throw new Error(`${failed} bundle(s) failed the behavioural check in ${variant}/${app}`);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args[0] === '--one') {
		await runOne(args[1], args[2], resolve(args[3]), (args[4] as any) ?? 'normal');
	} else {
		// children (patch anchors, negative tests) resolve Svelte via scripts/link-svelte.ts
		const svelteFlag = args.find((a) => a.startsWith('--svelte='))?.slice('--svelte='.length);
		if (svelteFlag) {
			process.env.SVELTE_REF = svelteFlag;
			delete process.env.SVELTE_DIR;
		}
		if (args.includes('--anchors')) {
			const proc = Bun.spawnSync(['bun', join(ROOT, 'scripts/patches-doc.ts'), '--check'], { env: process.env, stdout: 'inherit', stderr: 'inherit' });
			process.exit(proc.exitCode ?? 1);
		}
		const app = args.find((a) => a.startsWith('--app='))?.slice(6);
		const names = args.filter((a) => !a.startsWith('--'));
		const variants = names.length ? names : readdirSync(DIST).filter((d) => !d.startsWith('.'));
		let failed = 0;
		for (const v of variants) {
			for (const a of app ? [app] : readdirSync(join(DIST, v))) {
				if (!existsSync(join(DIST, v, a, 'index.html'))) continue;
				try {
					await check(v, a);
				} catch (e) {
					failed++;
					console.error(String(e));
				}
			}
		}
		// full run (no variant filter): also every patch anchor + the negative tests
		if (!names.length && !app) {
			for (const [label, cmd] of [
				['patch anchors (all client runtime files)', ['bun', join(ROOT, 'scripts/patches-doc.ts'), '--check']],
				['negative tests (minimal)', ['bun', join(ROOT, 'scripts/negative.ts'), 'minimal']]
			] as const) {
				const proc = Bun.spawnSync([...cmd], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
				console.log(`\n--- ${label}\n${proc.stdout.toString().trim()}`);
				if (proc.exitCode !== 0) {
					failed++;
					console.error(proc.stderr.toString());
				}
			}
		}
		if (failed) {
			console.error(`\n${failed} check group(s) FAILED`);
			process.exit(1);
		}
		console.log('\nall checks passed');
	}
}
