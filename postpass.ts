/**
 * Post-pass: dead code Bun 1.4.2 leaves in the bundle, removed losslessly.
 *
 * 1. Dead *private* class members (Bun never removes class members).
 * Private names (#x) are lexically scoped to their class body, so a private method or
 * field that is never referenced inside its class can be deleted with zero risk. This
 * matters once other patches fold a guard to a constant: e.g. with `async_mode_flag`
 * folded to false, `Batch.#commit` loses its only call site but still ships, together
 * with every top-level helper it calls.
 *
 * 2. Provably dead statements:
 *    - constant-false branches: `if (!1) { … }`. Bun keeps such a block whole, loops and
 *      conditions included, when it declares a `var` (to preserve hoisting); typically a
 *      DEV-only block after the DEV-const technique. Only the hoisted `var` names are kept.
 *    - statements after `return` / `throw` in the same block, e.g. `apply()` once
 *      `async_mode_flag` folds its guard to an unconditional `return`. Hoisted `var` names and
 *      function declarations are kept; a site whose dead tail declares `let`/`const`/`class`
 *      is left alone (removing those could change what a name resolves to).
 *    - constant-test expressions: `!1 && x`, `!0 || x`, `!1 ? a : b` (and their mirror images)
 *      keep only the part that can evaluate.
 *
 * 3. Opt-in (variant `postpass: { … }`): minifier work Bun doesn't do, see postpass-minify.ts
 *    (constant propagation, bit-flag tests, dead comma-expression tests). With these, each
 *    round of passes ends in a syntax-only re-bundle so Bun folds what they expose.
 *
 * All steps repeat until nothing changes.
 * Pipeline on dist/<variant>/<app>/:
 *   main.readable.js (Bun output, minify.syntax only: same DCE as main.min.js)
 *     -> delete unreferenced #private members and dead statements until fixpoint (acorn)
 *     -> re-bundle with Bun (syntax-only -> main.readable.js, full minify -> main.min.js),
 *        which tree-shakes helpers only the removed code used.
 * Module boundaries survive the re-bundle as legal comments (`/*! @module … *\/`), which
 * Bun keeps in place; they are turned back into `// path` markers in the readable output
 * and stripped from main.min.js, so measure.ts can still attribute bytes to modules.
 * If nothing is removable the outputs are left untouched (no re-bundle noise).
 * main.js (minify: false) is not post-processed.
 */
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SVELTE_DIR } from './scripts/link-svelte.ts';
import { inlineConstants, removeDeadSequenceTests, simplifyFlagTests, type MinifyOptions } from './postpass-minify.ts';

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

const FALSE = (n: any) =>
	(n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'Literal' && n.argument.value === 1) ||
	(n.type === 'Literal' && (n.value === false || n.value === 0 || n.value === null));
const TRUE = (n: any) =>
	(n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'Literal' && n.argument.value === 0) ||
	(n.type === 'Literal' && n.value === true);
const SCOPE = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression|ClassDeclaration|ClassExpression)$/;

/** `var` names declared in a subtree: they hoist out of blocks (not out of functions/classes). */
function hoistedVars(nodes: any[]): string[] {
	const names = new Set<string>();
	const pattern = (p: any): void => {
		if (!p) return;
		if (p.type === 'Identifier') names.add(p.name);
		else if (p.type === 'ObjectPattern') for (const q of p.properties) pattern(q.type === 'RestElement' ? q.argument : q.value);
		else if (p.type === 'ArrayPattern') p.elements.forEach(pattern);
		else if (p.type === 'AssignmentPattern') pattern(p.left);
		else if (p.type === 'RestElement') pattern(p.argument);
	};
	const visit = (n: any): void => {
		if (!n || typeof n.type !== 'string' || SCOPE.test(n.type)) return;
		if (n.type === 'VariableDeclaration' && n.kind === 'var') for (const d of n.declarations) pattern(d.id);
		for (const key in n) {
			const v = n[key];
			if (Array.isArray(v)) v.forEach(visit);
			else if (v && typeof v === 'object') visit(v);
		}
	};
	nodes.forEach(visit);
	return [...names];
}

/** One pass: returns the source without provably dead statements, and what was removed. */
export function removeDeadStatements(src: string) {
	const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
	const cuts: Array<[number, number, string, string]> = [];
	const vars = (nodes: any[]) => {
		const names = hoistedVars(nodes);
		return names.length ? `var ${names.join(', ')};` : '';
	};
	const visit = (n: any): void => {
		if (!n || typeof n.type !== 'string') return;
		if (n.type === 'IfStatement' && (FALSE(n.test) || TRUE(n.test))) {
			const [live, dead] = FALSE(n.test) ? [n.alternate, n.consequent] : [n.consequent, n.alternate];
			const keep = vars(dead ? [dead] : []);
			const liveSrc = live ? src.slice(live.start, live.end) : '';
			cuts.push([n.start, n.end, keep && liveSrc ? `{${keep}${liveSrc}}` : keep || liveSrc || ';', `if (${FALSE(n.test) ? 'false' : 'true'})`]);
			return; // the live branch is revisited on the next pass
		}
		// expressions: `!1 && x` -> `!1`, `!0 || x` -> `!0` (x never evaluates); `!1 || x`, `!0 && x` -> `x`;
		// `!1 ? a : b` -> `b`. Parenthesised, so the replacement is valid wherever the expression was.
		if (n.type === 'LogicalExpression' && (n.operator === '&&' || n.operator === '||') && (FALSE(n.left) || TRUE(n.left))) {
			const shortCircuit = n.operator === '&&' ? FALSE(n.left) : TRUE(n.left);
			const keep = shortCircuit ? n.left : n.right;
			cuts.push([n.start, n.end, `(${src.slice(keep.start, keep.end)})`, `${src.slice(n.left.start, n.left.end)} ${n.operator}`]);
			return;
		}
		if (n.type === 'ConditionalExpression' && (FALSE(n.test) || TRUE(n.test))) {
			const keep = FALSE(n.test) ? n.alternate : n.consequent;
			cuts.push([n.start, n.end, `(${src.slice(keep.start, keep.end)})`, `${FALSE(n.test) ? 'false' : 'true'} ? :`]);
			return;
		}
		const body = n.type === 'BlockStatement' || n.type === 'StaticBlock' ? n.body : n.type === 'SwitchCase' ? n.consequent : null;
		if (body) {
			const i = body.findIndex((s: any) => s.type === 'ReturnStatement' || s.type === 'ThrowStatement');
			const tail = i >= 0 ? body.slice(i + 1) : [];
			const lexical = tail.some((s: any) => s.type === 'ClassDeclaration' || (s.type === 'VariableDeclaration' && s.kind !== 'var'));
			// what's left once cut (function declarations, bare `var x;`) doesn't count, or this never reaches a fixpoint
			const kept = (s: any) =>
				s.type === 'FunctionDeclaration' || (s.type === 'VariableDeclaration' && s.kind === 'var' && s.declarations.every((d: any) => !d.init));
			const dead = tail.filter((s: any) => !kept(s));
			if (dead.length && !lexical) {
				const fns = tail.filter((s: any) => s.type === 'FunctionDeclaration').map((s: any) => src.slice(s.start, s.end));
				cuts.push([tail[0].start, tail.at(-1).end, vars(tail.filter((s: any) => s.type !== 'FunctionDeclaration')) + fns.join('\n'), 'after return']);
				// kept function declarations are copied verbatim; dead code inside them is cut on the next pass
				body.slice(0, i + 1).forEach(visit);
				return;
			}
		}
		for (const key in n) {
			const v = n[key];
			if (Array.isArray(v)) v.forEach(visit);
			else if (v && typeof v === 'object') visit(v);
		}
	};
	visit(ast);
	let out = src;
	for (const [s, e, text] of cuts.sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + text + out.slice(e);
	return { out, removed: cuts.map(([s, e, , kind]) => `dead ${kind} (${e - s} chars)`) };
}

// Bun's `// <path>` module markers, wherever Svelte lives (vendor/svelte/<ref>/…, ../svelte/…, apps/…)
const MODULE_LINE = /^\/\/ (\S+\.(?:[cm]?js|ts|svelte))$/gm;
const MODULE_LEGAL = /\/\*! @module (\S+) \*\//g;

/** Opt-in steps on top of the dead-code removal (postpass-minify.ts). */
export type PostpassOptions = MinifyOptions;

/** Run the post-pass on one app output dir. Returns what was removed (empty = untouched). */
export async function postpass(dir: string, opts: PostpassOptions = {}): Promise<string[]> {
	let readable = await Bun.file(join(dir, 'main.readable.js')).text();
	const removed: string[] = [];
	const steps = [
		removeDeadPrivate,
		removeDeadStatements,
		...(opts.constants ? [inlineConstants] : []),
		...(opts.flagTests ? [simplifyFlagTests] : []),
		...(opts.sequenceTests ? [removeDeadSequenceTests] : [])
	];
	// The minify steps leave expressions for Bun to fold (`!!1`, `2 | 1024`, `if (!1)` with a
	// `var`), so with them each round ends in a syntax-only re-bundle, until a round changes nothing.
	for (let round = 1; ; round++) {
		if (round > 20) throw new Error(`post-pass: no fixpoint after 20 rounds in ${dir}`);
		const before = removed.length;
		for (let pass = 1; ; pass++) {
			if (pass > 50) throw new Error(`post-pass: no fixpoint after 50 passes in ${dir}`);
			let changed = false;
			for (const step of steps) {
				const r = step(readable);
				if (!r.removed.length) continue;
				removed.push(...r.removed);
				readable = r.out;
				changed = true;
			}
			if (!changed) break;
		}
		if (steps.length === 2 || removed.length === before) break;
		readable = await rebundle(dir, readable, { syntax: true });
	}
	if (!removed.length) return removed;

	await Bun.write(join(dir, 'main.readable.js'), await rebundle(dir, readable, { syntax: true }));
	await Bun.write(join(dir, 'main.min.js'), await rebundle(dir, readable, true));
	return removed;
}

/** Re-bundle post-passed source with Bun, keeping the `// <module>` markers in readable output. */
async function rebundle(dir: string, code: string, minify: { syntax: true } | true) {
	const tmp = join(dir, '.postpass-input.js');
	await Bun.write(tmp, code.replace(MODULE_LINE, '/*! @module $1 */'));
	try {
		const r = await Bun.build({ entrypoints: [tmp], minify, target: 'browser', format: 'esm' });
		if (!r.success) throw new AggregateError(r.logs, 'post-pass re-bundle failed');
		const text = await r.outputs[0].text();
		// Bun prefixes the entry's own path comment; drop it
		return (minify === true ? text.replace(MODULE_LEGAL, '') : text.replace(MODULE_LEGAL, '// $1')).replace(/^\/\/ \.postpass-input\.js\n/m, '');
	} finally {
		rmSync(tmp, { force: true });
	}
}
