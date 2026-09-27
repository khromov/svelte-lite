/**
 * Minifier work Bun 1.4.2 doesn't do but Oxc (Vite 8) does: opt-in post-pass steps, enabled
 * per variant with `postpass: { constants, flagTests, sequenceTests }` (postpass.ts runs them).
 * Each is lossless by construction:
 *
 * - constants: a top-level binding that holds a literal and is never written anywhere in the
 *   bundle is that literal. Bun never propagates a binding across modules or a `let` at all, so
 *   `async_mode_flag`/`legacy_mode_flag` (`let … = false`, setters tree-shaken) keep the whole
 *   async and legacy paths alive, and effect flags stay variables (`DERIVED | CLEAN`). Inlined, and
 *   a syntax-only re-bundle folds what they guarded. A read before the binding is initialised
 *   would see `undefined` (Bun emits module-level `const`/`let` as `var`), so a binding is only
 *   inlined if no code that runs before its declaration can reach it.
 * - flagTests: `(x & N) !== 0` -> `x & N`, `(x & N) === 0` -> `!(x & N)` wherever only the
 *   truthiness is used. With a number literal operand, `&` yields a number or throws a TypeError
 *   (BigInt), before and after.
 * - sequenceTests: `if (a, !1) X else Y` -> `{ a; if (!1) X else Y }`, which the dead-statement
 *   pass then folds. Bun leaves a constant at the end of a comma expression when X declares a
 *   `var` (DEV-only blocks after the DEV-const technique).
 *
 * Every step takes and returns source (main.readable.js) like the other post-pass steps.
 */
import { join } from 'node:path';
import { SVELTE_DIR } from './scripts/link-svelte.ts';

const acorn: any = await import(Bun.resolveSync('acorn', join(SVELTE_DIR, 'src')));
const parse = (src: string) => acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });

export interface MinifyOptions {
	constants?: boolean;
	flagTests?: boolean;
	sequenceTests?: boolean;
}

/** Longer strings stay variables: past the hydration markers (`[`, `]`, `[!`) inlining measured no better. */
const STRING_MAX = 3;

function each(node: any, visit: (n: any, parent: any, key: string) => void, parent: any = null, key = '') {
	if (!node || typeof node.type !== 'string') return;
	visit(node, parent, key);
	for (const k in node) {
		const v = node[k];
		if (Array.isArray(v)) for (const c of v) each(c, visit, node, k);
		else if (v && typeof v === 'object' && typeof v.type === 'string') each(v, visit, node, k);
	}
}

function apply(src: string, cuts: Array<[number, number, string]>) {
	let out = src;
	for (const [s, e, text] of [...cuts].sort((a, b) => b[0] - a[0])) out = out.slice(0, s) + text + out.slice(e);
	return out;
}

/** Is this Identifier read as a variable (not a property key, label, or declared name)? */
function isReference(parent: any, key: string) {
	switch (parent?.type) {
		case 'MemberExpression':
			return key !== 'property' || parent.computed;
		case 'Property':
			return key !== 'key' || parent.computed; // shorthand `{ x }`: the value copy is the reference
		case 'MethodDefinition':
		case 'PropertyDefinition':
			return key !== 'key' || parent.computed;
		case 'VariableDeclarator':
			return key !== 'id';
		case 'FunctionDeclaration':
		case 'FunctionExpression':
		case 'ArrowFunctionExpression':
			return key !== 'id' && key !== 'params';
		case 'ClassDeclaration':
		case 'ClassExpression':
			return key !== 'id';
		case 'CatchClause':
			return key !== 'param';
		case 'LabeledStatement':
		case 'BreakStatement':
		case 'ContinueStatement':
		case 'ImportSpecifier':
		case 'ImportDefaultSpecifier':
		case 'ImportNamespaceSpecifier':
		case 'ExportSpecifier':
		case 'MetaProperty':
			return false;
		default:
			return true;
	}
}

function patternNames(p: any, into: (name: string) => void): void {
	if (!p) return;
	if (p.type === 'Identifier') into(p.name);
	else if (p.type === 'ObjectPattern') for (const q of p.properties) patternNames(q.type === 'RestElement' ? q.argument : q.value, into);
	else if (p.type === 'ArrayPattern') for (const e of p.elements) patternNames(e, into);
	else if (p.type === 'AssignmentPattern') patternNames(p.left, into);
	else if (p.type === 'RestElement') patternNames(p.argument, into);
	// MemberExpression targets (`a.b = …`) write no binding
}

const LITERAL_CTOR = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

/**
 * Evaluating this (at the top level) runs no code of the bundle: literals, names, functions,
 * plain object/array literals, `new Set()` & co., `Symbol('x')`, classes without static code.
 * Anything else counts as possibly calling into the bundle.
 */
function inert(n: any): boolean {
	if (!n) return true;
	switch (n.type) {
		case 'Literal':
		case 'Identifier':
		case 'FunctionExpression':
		case 'ArrowFunctionExpression':
		case 'FunctionDeclaration':
		case 'EmptyStatement':
			return true;
		case 'UnaryExpression':
			return ['!', 'typeof', 'void'].includes(n.operator) ? inert(n.argument) : n.operator !== 'delete' && n.argument.type === 'Literal';
		case 'BinaryExpression':
			return n.left.type === 'Literal' && n.right.type === 'Literal';
		case 'ArrayExpression':
			return n.elements.every((e: any) => !e || (e.type !== 'SpreadElement' && inert(e)));
		case 'ObjectExpression':
			return n.properties.every((p: any) => p.type === 'Property' && (!p.computed || p.key.type === 'Literal') && inert(p.value));
		case 'NewExpression':
			return n.callee.type === 'Identifier' && LITERAL_CTOR.has(n.callee.name) && n.arguments.length === 0;
		case 'CallExpression':
			return n.callee.type === 'Identifier' && n.callee.name === 'Symbol' && n.arguments.every((a: any) => a.type === 'Literal');
		case 'ClassDeclaration':
		case 'ClassExpression':
			return (
				(!n.superClass || n.superClass.type === 'Identifier') &&
				n.body.body.every(
					(m: any) =>
						m.type !== 'StaticBlock' &&
						(!m.computed || m.key.type === 'Literal') &&
						(m.type === 'MethodDefinition' || !m.static || inert(m.value))
				)
			);
		case 'VariableDeclaration':
			return n.declarations.every((d: any) => inert(d.init));
		default:
			return false;
	}
}

function literal(init: any): boolean {
	if (!init) return true; // `let x;` never written: undefined
	if (init.type === 'Literal') return !init.regex && init.bigint === undefined && (typeof init.value !== 'string' || init.value.length <= STRING_MAX);
	return init.type === 'UnaryExpression' && ['!', '-', 'void'].includes(init.operator) && init.argument.type === 'Literal' && typeof init.argument.value === 'number';
}

/** One pass: inline top-level literal bindings that are never written. */
export function inlineConstants(src: string) {
	const ast = parse(src);
	const declared = new Map<string, number>();
	const written = new Set<string>();
	const exported = new Set<string>();
	const refs: Array<{ node: any; parent: any }> = [];
	const declare = (name: string) => declared.set(name, (declared.get(name) ?? 0) + 1);
	each(ast, (n, parent, key) => {
		switch (n.type) {
			case 'VariableDeclarator':
				patternNames(n.id, declare);
				break;
			case 'FunctionDeclaration':
			case 'FunctionExpression':
			case 'ArrowFunctionExpression':
				if (n.id) declare(n.id.name);
				for (const p of n.params) patternNames(p, declare);
				break;
			case 'ClassDeclaration':
			case 'ClassExpression':
				if (n.id) declare(n.id.name);
				break;
			case 'CatchClause':
				patternNames(n.param, declare);
				break;
			case 'ImportSpecifier':
			case 'ImportDefaultSpecifier':
			case 'ImportNamespaceSpecifier':
				declare(n.local.name);
				break;
			case 'ExportSpecifier':
				exported.add(n.local.name);
				break;
			case 'ExportNamedDeclaration':
			case 'ExportDefaultDeclaration':
				each(n.declaration, (d) => d.type === 'VariableDeclarator' && patternNames(d.id, (x) => exported.add(x)));
				break;
			case 'AssignmentExpression':
				patternNames(n.left, (x) => written.add(x));
				break;
			case 'UpdateExpression':
				patternNames(n.argument, (x) => written.add(x));
				break;
			case 'ForInStatement':
			case 'ForOfStatement':
				if (n.left.type !== 'VariableDeclaration') patternNames(n.left, (x) => written.add(x));
				break;
			case 'Identifier':
				if (isReference(parent, key)) refs.push({ node: n, parent });
				break;
		}
	});

	// Names reachable from code that has run so far: everything a statement that runs code
	// refers to, through the top-level functions, classes and initialisers it names.
	const defs = new Map<string, any>();
	for (const s of ast.body) {
		if (s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') defs.set(s.id.name, s);
		if (s.type === 'VariableDeclaration') for (const d of s.declarations) if (d.id.type === 'Identifier' && d.init) defs.set(d.id.name, d.init);
	}
	const reached = new Set<string>();
	const reach = (root: any) => {
		const queue = [root];
		while (queue.length) {
			each(queue.pop(), (n, parent, key) => {
				if (n.type !== 'Identifier' || !isReference(parent, key) || reached.has(n.name)) return;
				reached.add(n.name);
				if (defs.has(n.name)) queue.push(defs.get(n.name));
			});
		}
	};

	const value = new Map<string, string>();
	const gone = new Map<any, any[]>(); // declaration -> its inlined declarators
	for (const s of ast.body) {
		if (s.type !== 'VariableDeclaration') {
			if (!inert(s)) reach(s);
			continue;
		}
		for (const d of s.declarations) {
			const name = d.id.type === 'Identifier' ? d.id.name : null;
			if (name && literal(d.init) && declared.get(name) === 1 && !written.has(name) && !exported.has(name) && !reached.has(name)) {
				value.set(name, d.init ? src.slice(d.init.start, d.init.end) : 'void 0');
				gone.set(s, [...(gone.get(s) ?? []), d]);
			}
			if (!inert(d.init)) reach(d.init);
		}
	}

	const cuts: Array<[number, number, string]> = [];
	for (const { node, parent } of refs) {
		const v = value.get(node.name);
		if (v === undefined) continue;
		cuts.push(parent.type === 'Property' && parent.shorthand ? [parent.start, parent.end, `${node.name}: (${v})`] : [node.start, node.end, `(${v})`]);
	}
	for (const [s, ds] of gone) {
		const keep = s.declarations.filter((d: any) => !ds.includes(d));
		cuts.push([s.start, s.end, keep.length ? `${s.kind} ${keep.map((d: any) => src.slice(d.start, d.end)).join(', ')};` : '']);
	}
	return { out: apply(src, cuts), removed: [...value.keys()].map((name) => `inlined constant ${name}`) };
}

const ZERO = (n: any) => n.type === 'Literal' && n.value === 0;
const NUMBER = (n: any) => n.type === 'Literal' && typeof n.value === 'number';

/** One pass: `(x & N) !== 0` -> `x & N` and `(x & N) === 0` -> `!(x & N)` where only truthiness counts. */
export function simplifyFlagTests(src: string) {
	const ast = parse(src);
	const cuts: Array<[number, number, string]> = [];
	// `n` is only tested for truthiness
	const test = (n: any): void => {
		if (n.type === 'LogicalExpression') return test(n.left), test(n.right);
		if (n.type === 'UnaryExpression' && n.operator === '!') return test(n.argument);
		if (n.type !== 'BinaryExpression' || !['!==', '!=', '===', '=='].includes(n.operator)) return;
		const flags = ZERO(n.right) ? n.left : ZERO(n.left) ? n.right : null;
		if (flags?.type !== 'BinaryExpression' || flags.operator !== '&' || !(NUMBER(flags.left) || NUMBER(flags.right))) return;
		const and = src.slice(flags.start, flags.end);
		cuts.push([n.start, n.end, n.operator[0] === '!' ? `(${and})` : `!(${and})`]);
	};
	each(ast, (n) => {
		if (/^(IfStatement|WhileStatement|DoWhileStatement|ForStatement|ConditionalExpression)$/.test(n.type) && n.test) test(n.test);
		else if (n.type === 'UnaryExpression' && n.operator === '!') test(n.argument);
	});
	// a node reached twice (a `!` inside an `if` test) or inside another hit: the outermost wins,
	// the rest is picked up on the next pass
	const kept: Array<[number, number, string]> = [];
	for (const c of cuts.sort((a, b) => a[0] - b[0] || b[1] - a[1])) if (!kept.some((k) => k[0] <= c[0] && c[1] <= k[1])) kept.push(c);
	return { out: apply(src, kept), removed: kept.map(() => 'flag test') };
}

const CONSTANT = (n: any) =>
	(n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'Literal' && (n.argument.value === 0 || n.argument.value === 1)) ||
	(n.type === 'Literal' && typeof n.value === 'boolean');

/** One pass: `if (a, b, !1) X else Y` -> `{ a, b; if (!1) X else Y }`. */
export function removeDeadSequenceTests(src: string) {
	const cuts: Array<[number, number, string]> = [];
	const visit = (n: any): void => {
		if (!n || typeof n.type !== 'string') return;
		if (n.type === 'IfStatement' && n.test.type === 'SequenceExpression' && CONSTANT(n.test.expressions.at(-1))) {
			const exprs = n.test.expressions;
			const text = (x: any) => src.slice(x.start, x.end);
			const lead = src.slice(exprs[0].start, exprs.at(-2).end);
			const rest = `if (${text(exprs.at(-1))}) ${text(n.consequent)}${n.alternate ? ` else ${text(n.alternate)}` : ''}`;
			cuts.push([n.start, n.end, `{ ${lead}; ${rest} }`]);
			return; // the branches are revisited on the next pass
		}
		for (const key in n) {
			const v = n[key];
			if (Array.isArray(v)) v.forEach(visit);
			else if (v && typeof v === 'object') visit(v);
		}
	};
	visit(parse(src));
	return { out: apply(src, cuts), removed: cuts.map(([s, e]) => `dead sequence test (${e - s} chars)`) };
}
