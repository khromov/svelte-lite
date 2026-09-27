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

const ROOT = import.meta.dir;
/** Build output root: dist/, or --out=<dir> / SVELTE_LITE_DIST (set by build.ts --out). */
const outFlag = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
if (outFlag) process.env.SVELTE_LITE_DIST = resolve(outFlag);
const DIST = resolve(ROOT, process.env.SVELTE_LITE_DIST ?? 'dist');
const BUNDLES = ['main.min.js', 'main.js', 'main.readable.js'];

export interface TestContext {
	/** wait for Svelte's microtask batch flush (and a macrotask for good measure) */
	tick(): Promise<void>;
	/** dispatch a bubbling click, then tick */
	click(el: Element | null): Promise<void>;
	/** set an input's value and dispatch `input`, then tick */
	type(el: Element | null, value: string): Promise<void>;
	ok(cond: unknown, msg: string): void;
	eq(actual: unknown, expected: unknown, msg: string): void;
	/** identity: the node after hydration must be the very same node the server rendered */
	same(actual: unknown, expected: unknown, msg: string): void;
}

export interface AppTest<Refs = any> {
	/** runs against the SSR DOM, before the bundle hydrates it */
	before(doc: Document): Refs;
	/** runs after hydrate() */
	after(doc: Document, refs: Refs, t: TestContext): Promise<void>;
	/**
	 * Optional mismatch scenario: the SSR HTML is corrupted, hydrate() must warn
	 * (hydration_mismatch), fall back to a clean client render, and the app must still work.
	 */
	mismatch?: { corrupt(html: string): string; after(doc: Document, t: TestContext): Promise<void> };
}

/**
 * Run one bundle against one app's SSR HTML in this process (call once per process).
 * `bundle` defaults to dist/<variant>/<app>/main.min.js.
 */
export async function harness(variant: string, app: string, bundle: string, scenario: 'normal' | 'mismatch' = 'normal') {
	const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
	GlobalRegistrator.register({ url: 'http://localhost/' });

	const logged: string[] = [];
	for (const level of ['error', 'warn'] as const) {
		const orig = console[level];
		console[level] = (...args: unknown[]) => {
			logged.push(`${level}: ${args.map(String).join(' ')}`);
			orig(...args);
		};
	}
	const errors: string[] = [];
	window.addEventListener('error', (e: any) => errors.push(String(e.error ?? e.message)));
	process.on('unhandledRejection', (e) => errors.push(`unhandled rejection: ${e}`));

	const test: AppTest = (await import(join(ROOT, 'apps', app, 'test.ts'))).default;
	const dir = join(DIST, variant, app);
	let html = await Bun.file(join(dir, 'index.html')).text();
	if (scenario === 'mismatch') html = test.mismatch!.corrupt(html);
	const inner = (tag: string) => html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*)</${tag}>`))?.[1] ?? '';
	document.head.innerHTML = inner('head');
	document.body.innerHTML = inner('body').replace(/<script\b[\s\S]*?<\/script>/g, '');

	const failures: string[] = [];
	const tick = () => new Promise<void>((r) => setTimeout(r, 0)).then(() => new Promise<void>((r) => setTimeout(r, 0)));
	const t: TestContext = {
		tick,
		async click(el) {
			if (!el) return void failures.push('click(): element not found');
			(el as HTMLElement).dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }) as any);
			await tick();
		},
		async type(el, value) {
			if (!el) return void failures.push('type(): element not found');
			(el as HTMLInputElement).value = value;
			el.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
			await tick();
		},
		ok: (cond, msg) => void (cond || failures.push(msg)),
		eq: (a, b, msg) => void (Object.is(a, b) || failures.push(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)),
		same: (a, b, msg) => void (a === b && a != null ? 0 : failures.push(`${msg}: not the same node`))
	};

	let refs: any;
	try {
		if (scenario === 'normal') refs = test.before(document);
		await import(bundle);
		await tick();
		if (scenario === 'normal') await test.after(document, refs, t);
		else await test.mismatch!.after(document, t);
	} catch (e: any) {
		errors.push(e?.stack ?? String(e));
	}
	if (scenario === 'mismatch') {
		// expected: exactly the hydration_mismatch warning, nothing else
		const mismatch = logged.filter((l) => l.includes('hydration_mismatch'));
		if (mismatch.length === 0) failures.push('expected a hydration_mismatch warning');
		logged.splice(0, logged.length, ...logged.filter((l) => !l.includes('hydration_mismatch')));
	}
	const ok = failures.length === 0 && errors.length === 0 && logged.length === 0;
	await GlobalRegistrator.unregister();
	return { ok, failures, errors, logged };
}

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
