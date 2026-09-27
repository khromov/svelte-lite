/**
 * Byte-level coverage of the shipped bundles: which bytes of main.min.js actually execute
 * while hydrating the SSR page and running the app's interaction test? Uses V8 precise block
 * coverage (every block inside a function gets a count, not just the function), collected by
 * running the same harness as check.ts under Node (scripts/v8-coverage.ts).
 *
 *   bun scripts/byte-coverage.ts [variant ...] [--app=<name>]
 *     default variants: baseline optimized minimal minimal+strict-hydration+short-errors; default apps: every app in apps/
 *   bun scripts/byte-coverage.ts --report      regenerate COVERAGE.md from existing results
 *
 * Needs a prior build (dist/<variant>/<app>/) and Node >= 26 on PATH (or NODE=/path/to/node).
 *
 * Per variant/app, into dist/<variant>/<app>/:
 *   byte-coverage.json     executed / never-executed min bytes per top-level function and class member
 *   coverage.readable.txt  main.readable.js with a per-line gutter: ' ' executed, '-' never, '~' partly
 * and regenerates COVERAGE.md (the hand-written block between the notes markers is kept).
 *
 * "Never executed" is what this app's test didn't run. That is an upper bound on what could be
 * dropped for *this* app, not a list of dead code: error paths, teardown and update branches the
 * test doesn't trigger are still needed.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, SVELTE_DIR } from './link-svelte.ts';
import { categorize, shortPath } from '../measure.ts';

const acorn: any = await import(Bun.resolveSync('acorn', join(SVELTE_DIR, 'src')));
const DIST = resolve(ROOT, process.env.SVELTE_LITE_DIST ?? 'dist');
const NODE = process.env.NODE ?? 'node';
const VARIANTS = ['baseline', 'optimized', 'minimal', 'minimal+strict-hydration+short-errors'];
const APPS = readdirSync(join(ROOT, 'apps')).filter((a) => existsSync(join(ROOT, 'apps', a, 'test.ts')));

type V8Function = { functionName: string; ranges: Array<{ startOffset: number; endOffset: number; count: number }> };
type Row = { module: string; category: string; name: string; bytes: number; unexecuted: number; start: number; end: number };
type DeadSite = { kind: string; bytes: number; in: string; code: string };
type Result = {
	variant: string;
	app: string;
	svelte: string;
	total: number;
	executed: number;
	/** function-level view from scripts/coverage.ts, if present: share of bytes in functions that ran at all */
	functionLevelRan?: number;
	/** provably dead: constant-false branches and code after return/throw, which can never execute */
	dead: number;
	deadSites: DeadSite[];
	rows: Row[];
};

// --- coverage math ------------------------------------------------------------------------

/** Per UTF-16 index: execution count of the innermost V8 range containing it. */
function counts(src: string, fns: V8Function[]): Int32Array {
	const c = new Int32Array(src.length);
	const ranges = fns.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
	// V8 ranges nest properly; painting outer-first leaves the innermost count on every index
	for (const r of ranges) c.fill(r.count, r.startOffset, r.endOffset);
	return c;
}

/** Prefix sums (in UTF-8 bytes) of all bytes and of executed bytes, indexed by UTF-16 offset. */
function prefixes(src: string, c: Int32Array) {
	const all = new Float64Array(src.length + 1);
	const run = new Float64Array(src.length + 1);
	for (let i = 0; i < src.length; i++) {
		const u = src.charCodeAt(i);
		const b = u < 0x80 ? 1 : u < 0x800 ? 2 : u >= 0xd800 && u <= 0xdbff ? 4 : u >= 0xdc00 && u <= 0xdfff ? 0 : 3;
		all[i + 1] = all[i] + b;
		run[i + 1] = run[i] + (c[i] > 0 ? b : 0);
	}
	return {
		bytes: (a: number, b: number) => all[b] - all[a],
		unexecuted: (a: number, b: number) => all[b] - all[a] - (run[b] - run[a])
	};
}

function v8(variant: string, app: string, bundle: string): V8Function[] {
	const p = Bun.spawnSync([NODE, join(ROOT, 'scripts/v8-coverage.ts'), variant, app, bundle], {
		cwd: ROOT,
		env: process.env,
		stdout: 'pipe',
		stderr: 'pipe'
	});
	if (p.exitCode !== 0) throw new Error(`v8-coverage failed for ${variant}/${app}:\n${p.stderr}`);
	return JSON.parse(p.stdout.toString());
}

/**
 * Code that can never execute, whatever the app does: branches under a constant-false test
 * (`if (!1)`, `!1 && x`, `!1 ? x : y`) and statements after a return/throw in the same block.
 * Bun 1.4.2 leaves these in when, e.g., the dead block declares a `var` (see CLAUDE.md).
 */
function deadCode(program: any, bytes: (a: number, b: number) => number, src: string) {
	const falsy = (n: any) =>
		n &&
		((n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'Literal' && n.argument.value === 1) ||
			(n.type === 'Literal' && (n.value === false || n.value === 0 || n.value === null)));
	const truthy = (n: any) =>
		n &&
		((n.type === 'UnaryExpression' && n.operator === '!' && n.argument.type === 'Literal' && n.argument.value === 0) ||
			(n.type === 'Literal' && n.value === true));
	const sites: Array<{ kind: string; start: number; end: number }> = [];
	const walk = (n: any) => {
		if (!n || typeof n.type !== 'string') return;
		if (n.type === 'IfStatement' && falsy(n.test)) sites.push({ kind: 'if (false)', start: n.consequent.start, end: n.consequent.end });
		else if (n.type === 'IfStatement' && truthy(n.test) && n.alternate) sites.push({ kind: 'if (true) else', start: n.alternate.start, end: n.alternate.end });
		else if (n.type === 'ConditionalExpression' && falsy(n.test)) sites.push({ kind: 'false ? :', start: n.consequent.start, end: n.consequent.end });
		else if (n.type === 'ConditionalExpression' && truthy(n.test)) sites.push({ kind: 'true ? :', start: n.alternate.start, end: n.alternate.end });
		else if (n.type === 'LogicalExpression' && n.operator === '&&' && falsy(n.left)) sites.push({ kind: 'false &&', start: n.right.start, end: n.right.end });
		else if (n.type === 'LogicalExpression' && n.operator === '||' && truthy(n.left)) sites.push({ kind: 'true ||', start: n.right.start, end: n.right.end });
		const body = n.type === 'BlockStatement' || n.type === 'Program' ? n.body : n.type === 'SwitchCase' ? n.consequent : null;
		if (body) {
			const i = body.findIndex((s: any) => s.type === 'ReturnStatement' || s.type === 'ThrowStatement');
			// function declarations and bare `var x;` after a return are hoisted, not dead (postpass.ts keeps them too)
			const hoisted = (s: any) =>
				s.type === 'FunctionDeclaration' || (s.type === 'VariableDeclaration' && s.kind === 'var' && s.declarations.every((d: any) => !d.init));
			const rest = i >= 0 ? body.slice(i + 1).filter((s: any) => !hoisted(s)) : [];
			if (rest.length) sites.push({ kind: 'after return', start: rest[0].start, end: rest.at(-1).end });
		}
		for (const k in n) {
			const v = n[k];
			if (Array.isArray(v)) v.forEach(walk);
			else if (v && typeof v === 'object') walk(v);
		}
	};
	walk(program);
	return sites.map((s) => ({ ...s, bytes: bytes(s.start, s.end), code: src.slice(s.start, s.start + 70) }));
}

// --- one variant x app ----------------------------------------------------------------------

function measureOne(variant: string, app: string): Result {
	const dir = join(DIST, variant, app);
	const minPath = join(dir, 'main.min.js');
	const readablePath = join(dir, 'main.readable.js');
	const minSrc = readFileSync(minPath, 'utf8');
	const readableSrc = readFileSync(readablePath, 'utf8');

	const minCount = counts(minSrc, v8(variant, app, minPath));
	const readableCount = counts(readableSrc, v8(variant, app, readablePath));
	const P = prefixes(minSrc, minCount);

	// Attribute min bytes to top-level functions / class members. The readable and minified
	// builds have identical DCE, so their top-level statements align 1:1: names and modules come
	// from the readable build, byte counts from the minified one.
	const comments: any[] = [];
	const R = acorn.parse(readableSrc, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments }).body;
	const minProgram = acorn.parse(minSrc, { ecmaVersion: 'latest', sourceType: 'module' });
	const M = minProgram.body;
	if (R.length !== M.length) throw new Error(`${variant}/${app}: readable/min statement mismatch`);
	const marks = comments.filter((c) => c.type === 'Line' && /^ \S+\.(?:[cm]?js|ts|svelte)$/.test(c.value));
	const classOf = (n: any) =>
		n.type === 'ClassDeclaration' ? n
		: n.type === 'VariableDeclaration' ? n.declarations.find((d: any) => d.init?.type === 'ClassExpression')?.init
		: n.type === 'IfStatement' && n.consequent?.expression?.right?.type === 'ClassExpression' ? n.consequent.expression.right
		: null;

	const rows: Row[] = [];
	const row = (module: string, name: string, n: any) =>
		rows.push({ module, category: categorize(module), name, bytes: P.bytes(n.start, n.end), unexecuted: P.unexecuted(n.start, n.end), start: n.start, end: n.end });
	let mi = -1;
	R.forEach((node: any, i: number) => {
		while (mi + 1 < marks.length && marks[mi + 1].start < node.start) mi++;
		const module = mi >= 0 ? shortPath(marks[mi].value.trim()) : '?';
		const m = M[i];
		const cls = classOf(node);
		const mcls = classOf(m);
		if (cls && mcls && cls.body.body.length === mcls.body.body.length) {
			const name = cls.id?.name ?? node.declarations?.[0]?.id?.name ?? 'SvelteElement';
			cls.body.body.forEach((mem: any, j: number) => {
				const key = mem.key?.type === 'PrivateIdentifier' ? `#${mem.key.name}` : (mem.key?.name ?? '?');
				row(module, `${name}.${key}`, mcls.body.body[j]);
			});
			return;
		}
		const name =
			node.type === 'FunctionDeclaration' ? node.id.name
			: node.type === 'VariableDeclaration' ? node.declarations.map((d: any) => d.id.name ?? '{…}').join(', ')
			: readableSrc.slice(node.start, Math.min(node.end, node.start + 50)).replace(/\s+/g, ' ');
		row(module, name, m);
	});

	// readable bundle with a per-line gutter, for reading what didn't run
	const lines: string[] = [
		`// V8 block coverage of ${variant}/${app}/main.readable.js while hydrating + running apps/${app}/test.ts`,
		`// gutter: ' ' executed   '-' never executed   '~' partly executed`,
		''
	];
	let at = 0;
	for (const line of readableSrc.split('\n')) {
		let ran = 0;
		let not = 0;
		for (let i = 0; i < line.length; i++) {
			if (/\s/.test(line[i])) continue;
			if (readableCount[at + i] > 0) ran++;
			else not++;
		}
		lines.push(`${not === 0 ? ' ' : ran === 0 ? '-' : '~'} ${line}`);
		at += line.length + 1;
	}
	writeFileSync(join(dir, 'coverage.readable.txt'), lines.join('\n'));

	const total = P.bytes(0, minSrc.length);
	const executed = total - P.unexecuted(0, minSrc.length);
	let functionLevelRan: number | undefined;
	try {
		const fl = JSON.parse(readFileSync(join(dir, 'coverage.json'), 'utf8'));
		functionLevelRan = ((fl.byStatus?.ran ?? 0) + (fl.byStatus?.['module init'] ?? 0)) / fl.total;
	} catch {}
	let svelte = '?';
	try {
		const s = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')).svelte;
		if (s) svelte = `${s.tag ?? s.ref} @ ${String(s.sha).slice(0, 12)}`;
	} catch {}
	const deadSites = deadCode(minProgram, P.bytes, minSrc).map((s) => ({
		kind: s.kind,
		bytes: s.bytes,
		in: rows.find((r) => r.start <= s.start && s.end <= r.end)?.name ?? '?',
		code: s.code
	}));
	const dead = deadSites.reduce((sum, s) => sum + s.bytes, 0);
	const result: Result = { variant, app, svelte, total, executed, functionLevelRan, dead, deadSites, rows };
	writeFileSync(join(dir, 'byte-coverage.json'), JSON.stringify(result, null, 2));
	return result;
}

// --- COVERAGE.md --------------------------------------------------------------------------------

const n = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`;

function report() {
	const results: Result[] = [];
	for (const v of VARIANTS)
		for (const a of APPS) {
			const f = join(DIST, v, a, 'byte-coverage.json');
			if (existsSync(f)) results.push(JSON.parse(readFileSync(f, 'utf8')));
		}
	const get = (v: string, a: string) => results.find((r) => r.variant === v && r.app === a);
	const apps = APPS.filter((a) => results.some((r) => r.app === a));
	const minimal = apps.map((a) => get('minimal', a)).filter(Boolean) as Result[];

	const md: string[] = [
		'# COVERAGE: how much of the shipped bundle actually runs',
		'',
		'<!-- generated by scripts/byte-coverage.ts; edit only the notes block -->',
		'',
		'V8 precise **block** coverage of `main.min.js` while each app is hydrated from its SSR HTML and put through its interaction test (`apps/<app>/test.ts`, the same harness as `check.ts`, run under Node). Every block inside a function is counted, so a function that ran but skipped most of its branches only counts the branches that ran. Bytes are UTF-8 bytes of the minified bundle.',
		'',
		'"Never executed" means this test didn\'t run it. It is an upper bound on what could be dropped for this app, not a list of dead code: error handling, teardown and update paths the test doesn\'t trigger are still needed.',
		'',
		`Svelte: ${[...new Set(results.map((r) => `${r.variant} = ${r.svelte}`))].join(' · ')}`,
		'',
		'## Executed share of `main.min.js`',
		'',
		`| app | ${VARIANTS.join(' | ')} |`,
		`| --- | ${VARIANTS.map(() => '---:').join(' | ')} |`,
		...apps.map(
			(a) =>
				`| ${a} | ${VARIANTS.map((v) => {
					const r = get(v, a);
					return r ? `**${pct(r.executed, r.total)}** of ${n(r.total)} B` : '—';
				}).join(' | ')} |`
		),
		'',
		'Never-executed bytes:',
		'',
		`| app | ${VARIANTS.join(' | ')} |`,
		`| --- | ${VARIANTS.map(() => '---:').join(' | ')} |`,
		...apps.map(
			(a) =>
				`| ${a} | ${VARIANTS.map((v) => {
					const r = get(v, a);
					return r ? `${n(r.total - r.executed)} B` : '—';
				}).join(' | ')} |`
		),
		'',
		'## Provably dead bytes',
		'',
		'Code that can never execute, whatever the app does: branches under a constant-false test (`if (!1)`, `!1 && x`) and statements after a `return`/`throw`. Pure waste, left in by Bun 1.4.2 or by our own patches. It is a subset of the never-executed bytes above.',
		'',
		`| app | ${VARIANTS.join(' | ')} |`,
		`| --- | ${VARIANTS.map(() => '---:').join(' | ')} |`,
		...apps.map(
			(a) =>
				`| ${a} | ${VARIANTS.map((v) => {
					const r = get(v, a);
					return r?.dead != null ? `${n(r.dead)} B (${r.deadSites.length} sites)` : '—';
				}).join(' | ')} |`
		),
		''
	];
	const deadMin = minimal.flatMap((r) => r.deadSites.map((s) => ({ ...s, app: r.app })));
	if (deadMin.length) {
		// the same site shows up in several apps' bundles: list it once, with its largest size
		const sites = new Map<string, DeadSite & { apps: string[] }>();
		for (const s of deadMin) {
			const k = `${s.in}::${s.kind}`;
			const e = sites.get(k) ?? { ...s, apps: [] };
			e.bytes = Math.max(e.bytes, s.bytes);
			e.apps.push(s.app);
			sites.set(k, e);
		}
		md.push(
			'Dead sites in `minimal`:',
			'',
			'| in | kind | min B | apps | code |',
			'| --- | --- | ---: | --- | --- |',
			...[...sites.values()]
				.sort((x, y) => y.bytes - x.bytes)
				.map((s) => `| \`${s.in}\` | ${s.kind} | ${n(s.bytes)} | ${s.apps.join(', ')} | \`${s.code.replace(/\|/g, '\\|')}…\` |`),
			''
		);
	}

	if (minimal.some((r) => r.functionLevelRan != null)) {
		md.push(
			'Block-level vs function-level for `minimal`. Function-level (`scripts/coverage.ts`) counts a whole function as used once it runs at all:',
			'',
			'| app | block-level executed | function-level "ran" |',
			'| --- | ---: | ---: |',
			...minimal.map((r) => `| ${r.app} | ${pct(r.executed, r.total)} | ${r.functionLevelRan != null ? `${(100 * r.functionLevelRan).toFixed(1)}%` : '—'} |`),
			''
		);
	}

	if (minimal.length) {
		const cats = [...new Set(minimal.flatMap((r) => r.rows.map((x) => x.category)))];
		const catBytes = (r: Result, c: string) => r.rows.filter((x) => x.category === c).reduce((s, x) => s + x.unexecuted, 0);
		cats.sort((x, y) => minimal.reduce((s, r) => s + catBytes(r, y), 0) - minimal.reduce((s, r) => s + catBytes(r, x), 0));
		md.push(
			'## `minimal`: never-executed bytes by category',
			'',
			`| category | ${minimal.map((r) => r.app).join(' | ')} |`,
			`| --- | ${minimal.map(() => '---:').join(' | ')} |`,
			...cats.filter((c) => minimal.some((r) => catBytes(r, c) > 0)).map((c) => `| ${c} | ${minimal.map((r) => n(catBytes(r, c))).join(' | ')} |`),
			''
		);

		md.push('## `minimal`: largest never-executed code per app', '');
		md.push('"never" = the whole function/member never ran; "partly" = it ran, but some of its branches didn\'t.', '');
		for (const r of minimal) {
			md.push(
				`### ${r.app}: ${n(r.total - r.executed)} of ${n(r.total)} B never executed`,
				'',
				'| function / member | module | never executed | of | |',
				'| --- | --- | ---: | ---: | --- |',
				...[...r.rows]
					.filter((x) => x.unexecuted > 0)
					.sort((x, y) => y.unexecuted - x.unexecuted)
					.slice(0, 12)
					.map((x) => `| \`${x.name}\` | \`${x.module}\` | ${n(x.unexecuted)} | ${n(x.bytes)} | ${x.unexecuted >= x.bytes ? 'never' : 'partly'} |`),
				''
			);
		}

		// runtime code that no app's test ever executed (keyed by module + name across bundles)
		const keyed = new Map<string, { module: string; name: string; bytes: number; apps: string[]; ranSomewhere: boolean }>();
		for (const r of minimal)
			for (const x of r.rows) {
				if (x.module.startsWith('apps/') || x.module === '?') continue;
				const k = `${x.module}::${x.name}`;
				const e = keyed.get(k) ?? { module: x.module, name: x.name, bytes: 0, apps: [], ranSomewhere: false };
				e.bytes = Math.max(e.bytes, x.bytes);
				e.apps.push(r.app);
				e.ranSomewhere ||= x.unexecuted < x.bytes;
				keyed.set(k, e);
			}
		const never = [...keyed.values()].filter((e) => !e.ranSomewhere).sort((a, b) => b.bytes - a.bytes);
		md.push(
			'## `minimal`: runtime functions no app ever executed',
			'',
			`${never.length} runtime functions/members, ${n(never.reduce((s, e) => s + e.bytes, 0))} B (largest bundle's size of each), are shipped in at least one app and never ran in any of them.`,
			'',
			'| function / member | module | min B | shipped in |',
			'| --- | --- | ---: | --- |',
			...never.slice(0, 30).map((e) => `| \`${e.name}\` | \`${e.module}\` | ${n(e.bytes)} | ${e.apps.join(', ')} |`),
			''
		);
	}

	md.push('Line-by-line view: `dist/<variant>/<app>/coverage.readable.txt`. Raw data: `dist/<variant>/<app>/byte-coverage.json`.', '');

	const out = join(ROOT, 'COVERAGE.md');
	const START = '<!-- notes:start -->';
	const END = '<!-- notes:end -->';
	let notes = `${START}\n${END}`;
	if (existsSync(out)) {
		const old = readFileSync(out, 'utf8');
		const s = old.indexOf(START);
		const e = old.indexOf(END);
		if (s >= 0 && e > s) notes = old.slice(s, e + END.length);
	}
	// notes go right after the intro paragraphs, before the tables
	const at = md.indexOf('## Executed share of `main.min.js`');
	md.splice(at, 0, notes, '');
	writeFileSync(out, md.join('\n'));
	console.log(`wrote ${out}`);
}

// --- main ---------------------------------------------------------------------------------------

const args = process.argv.slice(2);
if (!args.includes('--report')) {
	const nodeMajor = Number(Bun.spawnSync([NODE, '-p', 'process.versions.node.split(".")[0]']).stdout.toString().trim());
	if (!(nodeMajor >= 26)) throw new Error(`byte coverage needs Node >= 26 on PATH (or NODE=...), got ${nodeMajor || 'none'}`);
	const appFlag = args.find((a) => a.startsWith('--app='))?.slice(6);
	const variants = args.filter((a) => !a.startsWith('--'));
	for (const v of variants.length ? variants : VARIANTS)
		for (const a of appFlag ? [appFlag] : APPS) {
			if (!existsSync(join(DIST, v, a, 'main.min.js'))) {
				console.log(`skip ${v}/${a}: not built`);
				continue;
			}
			const r = measureOne(v, a);
			console.log(`${v.padEnd(10)} ${a.padEnd(9)} ${pct(r.executed, r.total).padStart(6)} executed  (${n(r.total - r.executed)} of ${n(r.total)} B never ran)`);
		}
}
report();
