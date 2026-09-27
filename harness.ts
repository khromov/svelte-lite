/**
 * The behavioural test harness: SSR HTML -> hydrate() -> the app's interaction test, in happy-dom.
 *
 * Runtime-neutral on purpose (node: APIs only, no Bun globals): check.ts and scripts/coverage.ts
 * run it under Bun, scripts/v8-coverage.ts runs the very same harness under Node to collect V8
 * block coverage (Bun's JavaScriptCore has no equivalent).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
/** Build output root: dist/, or --out=<dir> / SVELTE_LITE_DIST (set by build.ts --out). Read at call time: importers set it after imports run. */
const dist = () => resolve(ROOT, process.env.SVELTE_LITE_DIST ?? 'dist');

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
 * `bundle` is an absolute path, e.g. dist/<variant>/<app>/main.min.js.
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

	const test: AppTest = (await import(pathToFileURL(join(ROOT, 'apps', app, 'test.ts')).href)).default;
	const dir = join(dist(), variant, app);
	let html = readFileSync(join(dir, 'index.html'), 'utf8');
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
		await import(pathToFileURL(bundle).href);
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
