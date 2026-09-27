/**
 * Build-time patching of the linked Svelte runtime. The Svelte checkout is never edited:
 * this plugin rewrites module source in Bun's onLoad hook, so every variant is
 * "official Svelte + a documented patch list" (see PATCHES.md).
 *
 * Every patch is anchored and FAILS THE BUILD if its anchor is gone, so upstream drift
 * can't silently turn a patch into a no-op:
 *  - `replace`: [search, replacement, expectedCount?]. A string search must occur exactly
 *    `expectedCount` times (default: at least once); a RegExp must match (same count rule).
 *  - `removeMembers`: delete named class members (AST). Missing class/member = error.
 *  - `removeFunctions`: delete named function declarations (AST, any depth). Missing or
 *    ambiguous = error.
 *  - `replaceFunctions`: replace a named function declaration with new source (AST).
 *  - `prepend`: code inserted at the top of the module.
 *  - `contents`: replace the whole module (a stub).
 *  - `constImports` (plugin-level): turn named imports into module-local constants, e.g.
 *    `import { DEV } from 'esm-env'` -> `const DEV = false;`. Two Bun 1.4.2 limitations make
 *    this necessary (see BASELINE.md):
 *      1. constants are never propagated across modules;
 *      2. a module-local top-level `const` is only folded if it precedes every import and
 *         other statement, and not at all if the module has a named re-export. So the
 *         consts are prepended and `export { x } from 'y'` is split into import + export.
 *
 * `applyPatches()` is exported so scripts/patches-doc.ts can produce PATCHES.md from the
 * very same definitions the build uses.
 */
import type { BunPlugin } from 'bun';
import { dirname, join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

type Replacement = string | ((substring: string, ...args: any[]) => string);

export interface ConstImport {
	/** Bare specifier ('esm-env') or a path relative to the Svelte package root ('src/internal/flags/index.js'). */
	from: string;
	/** Imported binding name -> JS expression to substitute (must be foldable, e.g. 'false'). */
	values: Record<string, string>;
	/** Feature this serves (for PATCHES.md). */
	feature?: string;
	why?: string;
}

export interface SourcePatch {
	/** Path relative to the Svelte package root (e.g. 'src/internal/client/dom/hydration.js'), or a RegExp over that relative path. */
	file: string | RegExp;
	/** Feature this patch serves: 'dev' | 'pure' | 'legacy' | 'async' | 'transitions' | 'root-boundary' | 'delegation' | 'proxy' ... */
	feature: string;
	/** One-line rationale (shown in PATCHES.md and patches.log). */
	why: string;
	/**
	 * Text edits: [search, replacement, expectedCount?] or
	 * { find, replace, count?, hash? } where `hash` pins the exact upstream text a (lazy)
	 * RegExp matched, for edits that move or rewrite a whole block.
	 */
	replace?: Array<[string | RegExp, Replacement] | [string | RegExp, Replacement, number] | TextEdit>;
	removeMembers?: { class: string; members: string[] };
	removeFunctions?: string[];
	/**
	 * Replace a function declaration. `hash` pins the upstream source of the function being
	 * replaced (Bun.hash, hex): if upstream edits that function the build fails, so a
	 * replacement can never silently drop new upstream logic.
	 */
	replaceFunctions?: Record<string, { hash: string; code: string }>;
	contents?: string;
	/** Code prepended to the module (e.g. a `const` that must precede all imports to be folded). */
	prepend?: string;
	/** For RegExp `file` patches that intentionally match many files: don't fail when a file has no match. */
	optional?: boolean;
}

export interface TextEdit {
	find: string | RegExp;
	replace: Replacement;
	count?: number;
	hash?: string;
}

export interface PatchPluginOptions {
	svelteDir: string;
	patches?: SourcePatch[];
	constImports?: ConstImport[];
	/** Collected per-file log of what was changed. */
	log?: string[];
}

export interface AppliedPatch {
	file: string;
	feature: string;
	why: string;
}

// acorn comes from the Svelte checkout's node_modules (no extra deps here).
let acorn: any;
async function getAcorn(svelteDir: string) {
	return (acorn ??= await import(Bun.resolveSync('acorn', join(svelteDir, 'src'))));
}

const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g;

export function patchPlugin(opts: PatchPluginOptions): BunPlugin {
	const svelteDir = realpathSync(opts.svelteDir);
	const srcDir = resolve(svelteDir, 'src');
	const escaped = srcDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const filter = new RegExp(`^${escaped}/.*\\.js$`);

	return {
		name: 'svelte-lite-patch',
		setup(build) {
			if (!opts.patches?.length && !opts.constImports?.length) return;
			build.onLoad({ filter }, async ({ path }) => {
				const original = await Bun.file(path).text();
				const { code, applied } = await applyPatches(path, original, opts);
				if (code === original) return undefined; // untouched: let Bun load it normally
				for (const a of applied) opts.log?.push(`${a.file}: [${a.feature}] ${a.why}`);
				// Debug aid: SVELTE_LITE_DUMP=/some/dir writes every patched module there.
				if (process.env.SVELTE_LITE_DUMP) {
					await Bun.write(resolve(process.env.SVELTE_LITE_DUMP, relative(svelteDir, path)), code);
				}
				return { contents: code, loader: 'js' };
			});
		}
	};
}

/** Apply every matching patch to one module. Throws if any anchor is missing. */
export async function applyPatches(
	path: string,
	original: string,
	opts: PatchPluginOptions
): Promise<{ code: string; applied: AppliedPatch[] }> {
	const svelteDir = realpathSync(opts.svelteDir);
	const rel = relative(svelteDir, path);
	const applied: AppliedPatch[] = [];
	let code = original;

	for (const p of opts.patches ?? []) {
		if (typeof p.file === 'string' ? p.file !== rel : !p.file.test(rel)) continue;
		const before = code;
		const fail = (msg: string) => {
			throw new Error(`[svelte-lite patch] ${rel} (${p.feature}: ${p.why}): ${msg}`);
		};

		if (p.contents !== undefined) code = p.contents;

		for (const edit of p.replace ?? []) {
			const { find: search, replace: replacement, count: expected, hash } = Array.isArray(edit)
				? { find: edit[0], replace: edit[1], count: edit[2], hash: undefined }
				: edit;
			const matches =
				typeof search === 'string'
					? Array(code.split(search).length - 1).fill(search)
					: [...code.matchAll(search.global ? search : new RegExp(search.source, search.flags + 'g'))].map((m) => m[0]);
			const count = matches.length;
			if (count === 0 && p.optional) continue;
			if (count === 0) fail(`anchor not found: ${String(search).slice(0, 120)}`);
			if (expected !== undefined && count !== expected) {
				fail(`anchor found ${count}x, expected ${expected}x: ${String(search).slice(0, 120)}`);
			}
			for (const m of hash ? matches : []) {
				if (fnHash(m) !== hash) fail(`upstream code at ${String(search).slice(0, 80)} changed (hash ${fnHash(m)}, patch pinned ${hash}); review the edit`);
			}
			code =
				typeof search === 'string'
					? code.replaceAll(search, replacement as any)
					: code.replace(search, replacement as any);
		}

		// AST ops run after the text edits, so call sites of removed members are already gone
		// (a dangling `this.#x` would not even parse).
		if (p.removeMembers) code = removeMembers(await getAcorn(svelteDir), code, p.removeMembers, fail);
		if (p.removeFunctions) code = removeFunctions(await getAcorn(svelteDir), code, p.removeFunctions, fail);
		if (p.replaceFunctions) code = replaceFunctions(await getAcorn(svelteDir), code, p.replaceFunctions, fail);

		if (p.prepend) code = `${p.prepend}\n${splitReexports(code)}`;
		if (code !== before) applied.push({ file: rel, feature: p.feature, why: p.why });
	}

	if (opts.constImports?.length) code = applyConstImports(code, path, svelteDir, opts.constImports, applied);

	return { code, applied };
}

// ---------------------------------------------------------------------------------------------
// AST helpers

function parse(acorn: any, code: string) {
	const comments: any[] = [];
	const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments });
	return { ast, comments };
}

function walk(node: any, visit: (node: any, parent: any) => void, parent: any = null) {
	if (!node || typeof node.type !== 'string') return;
	visit(node, parent);
	for (const key in node) {
		const value = node[key];
		if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
		else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, visit, node);
	}
}

/** Extend [start, end) to swallow a directly preceding JSDoc/block comment and the trailing newline. */
function widen(code: string, comments: any[], start: number, end: number): [number, number] {
	for (const c of comments) {
		if (c.type === 'Block' && c.end <= start && /^\s*$/.test(code.slice(c.end, start))) start = c.start;
	}
	while (start > 0 && (code[start - 1] === '\t' || code[start - 1] === ' ')) start--;
	if (code[end] === '\n') end++;
	return [start, end];
}

function cut(code: string, ranges: Array<[number, number, string?]>) {
	for (const [s, e, text = ''] of [...ranges].sort((a, b) => b[0] - a[0])) code = code.slice(0, s) + text + code.slice(e);
	return code;
}

function memberName(m: any) {
	if (!m.key) return '';
	const key = m.key.type === 'PrivateIdentifier' ? `#${m.key.name}` : (m.key.name ?? m.key.value);
	return m.static ? `static ${key}` : key;
}

function removeMembers(acorn: any, code: string, spec: { class: string; members: string[] }, fail: (m: string) => never) {
	const { ast, comments } = parse(acorn, code);
	const classes: any[] = [];
	walk(ast, (n) => {
		if ((n.type === 'ClassDeclaration' || n.type === 'ClassExpression') && n.id?.name === spec.class) classes.push(n);
	});
	if (classes.length !== 1) fail(`expected exactly one class ${spec.class}, found ${classes.length}`);
	const body = classes[0].body.body;
	const ranges: Array<[number, number]> = [];
	for (const name of spec.members) {
		const matches = body.filter((m: any) => memberName(m) === name || memberName(m) === `static ${name}`);
		if (matches.length === 0) fail(`class ${spec.class} has no member ${name}`);
		for (const m of matches) ranges.push(widen(code, comments, m.start, m.end));
	}
	return cut(code, ranges);
}

function findFunctions(ast: any, name: string) {
	const found: Array<{ node: any; parent: any }> = [];
	walk(ast, (n, parent) => {
		if (n.type === 'FunctionDeclaration' && n.id?.name === name) found.push({ node: n, parent });
	});
	return found;
}

function removeFunctions(acorn: any, code: string, names: string[], fail: (m: string) => never) {
	const { ast, comments } = parse(acorn, code);
	const ranges: Array<[number, number]> = [];
	for (const name of names) {
		const found = findFunctions(ast, name);
		if (found.length !== 1) fail(`expected exactly one function ${name}, found ${found.length}`);
		const { node, parent } = found[0];
		const target = parent?.type === 'ExportNamedDeclaration' ? parent : node;
		ranges.push(widen(code, comments, target.start, target.end));
	}
	return cut(code, ranges);
}

export const fnHash = (text: string) => Bun.hash(text).toString(16);

function replaceFunctions(acorn: any, code: string, map: Record<string, { hash: string; code: string }>, fail: (m: string) => never) {
	const { ast } = parse(acorn, code);
	const ranges: Array<[number, number, string]> = [];
	for (const [name, { hash, code: replacement }] of Object.entries(map)) {
		const found = findFunctions(ast, name);
		if (found.length !== 1) fail(`expected exactly one function ${name}, found ${found.length}`);
		const { node } = found[0];
		const actual = fnHash(code.slice(node.start, node.end));
		if (actual !== hash) fail(`upstream function ${name}() changed (hash ${actual}, patch pinned ${hash}); review the replacement`);
		ranges.push([node.start, node.end, replacement.trim()]);
	}
	return cut(code, ranges);
}

// ---------------------------------------------------------------------------------------------
// constImports

function applyConstImports(code: string, file: string, svelteDir: string, rules: ConstImport[], applied: AppliedPatch[]): string {
	const hoisted: string[] = [];
	const rel = relative(svelteDir, file);
	code = code.replace(IMPORT_RE, (stmt, names: string, _q, spec: string) => {
		// several techniques may each const-ify different names from the same module
		const matching = rules.filter((r) => matchesSpecifier(r.from, spec, file, svelteDir));
		if (!matching.length) return stmt;
		const keep: string[] = [];
		const consts: string[] = [];
		for (const raw of names.split(',')) {
			const part = raw.trim();
			if (!part) continue;
			const [imported, local = imported] = part.split(/\s+as\s+/).map((s) => s.trim());
			const rule = matching.find((r) => imported in r.values);
			if (!rule) {
				keep.push(part);
				continue;
			}
			consts.push(`${local} = ${rule.values[imported]}`);
			applied.push({
				file: rel,
				feature: rule.feature ?? 'const',
				why: `${rule.why ?? 'import as foldable local const'}: const ${local} = ${rule.values[imported]} (from '${spec}')`
			});
		}
		if (consts.length === 0) return stmt;
		hoisted.push(...consts);
		return keep.length ? `import { ${keep.join(', ')} } from '${spec}';` : '';
	});
	return hoisted.length ? `const ${hoisted.join(', ')};\n${splitReexports(code)}` : code;
}

const REEXPORT_RE = /export\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g;
let rx = 0;

/** `export { a, b as c } from 'm'` -> `import { a as __rx0, b as __rx1 } from 'm'; export { __rx0 as a, __rx1 as c };` */
export function splitReexports(code: string): string {
	return code.replace(REEXPORT_RE, (_stmt, names: string, _q, spec: string) => {
		const imports: string[] = [];
		const exports: string[] = [];
		for (const raw of names.split(',')) {
			const part = raw.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').trim();
			if (!part) continue;
			const [imported, exported = imported] = part.split(/\s+as\s+/).map((x) => x.trim());
			const local = `__rx${rx++}`;
			imports.push(`${imported} as ${local}`);
			exports.push(`${local} as ${exported}`);
		}
		return `import { ${imports.join(', ')} } from '${spec}'; export { ${exports.join(', ')} };`;
	});
}

function matchesSpecifier(from: string, spec: string, file: string, svelteDir: string) {
	if (!from.startsWith('src/')) return spec === from;
	if (!spec.startsWith('.')) return false;
	return resolve(dirname(file), spec) === resolve(svelteDir, from);
}
