/**
 * Post-pass: dead *private* class member elimination (Bun never removes class members).
 *
 * Private names (#x) are lexically scoped to their class body, so a private method or
 * field that is never referenced inside its class can be deleted with zero risk. This
 * matters once other patches fold a guard to a constant: e.g. with `async_mode_flag`
 * folded to false, `Batch.#commit` loses its only call site but still ships, together
 * with every top-level helper it calls.
 *
 * Pipeline on dist/<variant>/<app>/:
 *   main.readable.js (Bun output, minify.syntax only: same DCE as main.min.js)
 *     -> delete unreferenced #private members until fixpoint (acorn)
 *     -> re-bundle with Bun (syntax-only -> main.readable.js, full minify -> main.min.js),
 *        which tree-shakes helpers only the removed members used.
 * Module boundaries survive the re-bundle as legal comments (`/*! @module … *\/`), which
 * Bun keeps in place; they are turned back into `// path` markers in the readable output
 * and stripped from main.min.js, so measure.ts can still attribute bytes to modules.
 * If nothing is removable the outputs are left untouched (no re-bundle noise).
 * main.js (minify: false) is not post-processed.
 */
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SVELTE_DIR } from './scripts/link-svelte.ts';

const acorn: any = await import(Bun.resolveSync('acorn', join(SVELTE_DIR, 'src')));

function walk(node: any, visit: (n: any) => void) {
	if (!node || typeof node.type !== 'string') return;
	visit(node);
	for (const key in node) {
		const v = node[key];
		if (Array.isArray(v)) for (const c of v) walk(c, visit);
		else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, visit);
	}
}

const PURE_INIT = /^(Literal|Identifier|ArrowFunctionExpression|FunctionExpression)$/;
const PURE_CTOR = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);
const pureInit = (v: any) =>
	!v || PURE_INIT.test(v.type) || (v.type === 'NewExpression' && v.callee.type === 'Identifier' && PURE_CTOR.has(v.callee.name) && v.arguments.length === 0);

/** One pass: returns the source without unreferenced private members, and their names. */
export function removeDeadPrivate(src: string) {
	const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
	const cuts: Array<[number, number, string]> = [];
	walk(ast, (node) => {
		if (node.type !== 'ClassBody') return;
		const defs = new Set(node.body.map((m: any) => m.key).filter((k: any) => k?.type === 'PrivateIdentifier'));
		const referenced = new Set<string>();
		walk(node, (n) => {
			if (n.type === 'PrivateIdentifier' && !defs.has(n)) referenced.add(n.name);
		});
		for (const m of node.body) {
			if (m.key?.type !== 'PrivateIdentifier' || referenced.has(m.key.name)) continue;
			// fields: only drop if the initializer can't have side effects we care about
			// (`new Map()`/`new Set()` etc. are fine: an unreachable private field's object is garbage)
			if (m.type === 'PropertyDefinition' && !pureInit(m.value)) continue;
			cuts.push([m.start, m.end, `#${m.key.name}`]);
		}
	});
	let out = src;
	for (const [s, e] of cuts.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + out.slice(e);
	return { out, removed: cuts.map((c) => c[2]) };
}

// Bun's `// <path>` module markers, wherever Svelte lives (vendor/svelte/<ref>/…, ../svelte/…, apps/…)
const MODULE_LINE = /^\/\/ (\S+\.(?:[cm]?js|ts|svelte))$/gm;
const MODULE_LEGAL = /\/\*! @module (\S+) \*\//g;

/** Run the post-pass on one app output dir. Returns the removed member names (empty = untouched). */
export async function privateDce(dir: string): Promise<string[]> {
	let readable = await Bun.file(join(dir, 'main.readable.js')).text();
	const removed: string[] = [];
	for (;;) {
		const r = removeDeadPrivate(readable);
		if (!r.removed.length) break;
		removed.push(...r.removed);
		readable = r.out;
	}
	if (!removed.length) return removed;

	const tmp = join(dir, '.postpass-input.js');
	await Bun.write(tmp, readable.replace(MODULE_LINE, '/*! @module $1 */'));
	try {
		for (const [file, minify] of [
			['main.readable.js', { syntax: true }],
			['main.min.js', true]
		] as const) {
			const r = await Bun.build({ entrypoints: [tmp], minify, target: 'browser', format: 'esm' });
			if (!r.success) throw new AggregateError(r.logs, 'post-pass re-bundle failed');
			let text = await r.outputs[0].text();
			text = file === 'main.min.js' ? text.replace(MODULE_LEGAL, '') : text.replace(MODULE_LEGAL, '// $1');
			// Bun prefixes the entry's own path comment; drop it
			text = text.replace(/^\/\/ \.postpass-input\.js\n/m, '');
			await Bun.write(join(dir, file), text);
		}
	} finally {
		rmSync(tmp, { force: true });
	}
	return removed;
}
