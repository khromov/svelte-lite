#!/usr/bin/env bun
/**
 * Which shipped runtime code actually *runs* for the app?
 *
 *   bun scripts/coverage.ts [variant] [app]     (default: baseline hello; needs a prior build)
 *
 * Instruments dist/<variant>/main.readable.js (a `__cov(id)` probe at the start of every
 * top-level function and class method), executes it in happy-dom in a child process,
 * and weighs each function/method with its size in main.min.js (readable and minified
 * builds have identical DCE, so their top-level statements align 1:1).
 * (`bun test --coverage` lcov was tried first; its line counts land on the last body
 * line of functions that never ran, so they can't be trusted at this granularity.)
 *
 * The bundle runs through the same harness as check.ts: SSR HTML -> hydrate() -> the app's
 * interaction test (apps/<app>/test.ts).
 *
 * Output: dist/<variant>/<app>/coverage.json + coverage.md.
 * "never ran" = shipped but not executed by that test. That is an upper bound on what a
 * lite build could drop for *this* app, not a list of dead code: error paths and
 * teardown legitimately don't run in a short test.
 */
import { join, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { ROOT, SVELTE_DIR } from './link-svelte.ts';
import { categorize, shortPath } from '../measure.ts';

// acorn comes from the Svelte checkout's node_modules (no extra deps here).
const acorn: any = await import(Bun.resolveSync('acorn', join(SVELTE_DIR, 'src')));

if (process.argv[2] === '--run') {
	// child: execute an instrumented bundle through the app's behavioural test
	// (SSR html -> hydrate -> interactions) and print the probe ids that fired
	const hit = new Set<number>();
	(globalThis as any).__cov = (id: number) => hit.add(id);
	const { harness } = await import('../check.ts');
	const res = await harness(process.argv[3], process.argv[4], process.argv[5]);
	if (!res.ok) throw new Error(`instrumented bundle failed its test: ${JSON.stringify(res)}`);
	console.log(JSON.stringify([...hit]));
	process.exit(0);
}

const variant = process.argv[2] ?? 'baseline';
const app = process.argv[3] ?? 'hello';
const dir = join(resolve(ROOT, process.env.SVELTE_LITE_DIST ?? 'dist'), variant, app); // build.ts --out=<dir>
const readablePath = join(dir, 'main.readable.js');

const readableSrc = await Bun.file(readablePath).text();
const minSrc = await Bun.file(join(dir, 'main.min.js')).text();
const comments: any[] = [];
const R = acorn.parse(readableSrc, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments }).body;
const M = acorn.parse(minSrc, { ecmaVersion: 'latest', sourceType: 'module' }).body;
if (R.length !== M.length) throw new Error('readable/min statement mismatch');
// Bun's `// <path>` module markers, wherever Svelte lives (vendor/svelte/<ref>/…, ../svelte/…, apps/…)
const marks = comments.filter((c) => c.type === 'Line' && /^ \S+\.(?:[cm]?js|ts|svelte)$/.test(c.value));

// --- instrument: one probe per top-level function / class method -------------------------
const probes: Array<{ at: number; text: string }> = [];
let nextId = 0;
const probe = (fn: any): number => {
	const id = nextId++;
	if (fn.body.type === 'BlockStatement') probes.push({ at: fn.body.start + 1, text: `__cov(${id});` });
	else {
		probes.push({ at: fn.body.start, text: `(__cov(${id}), ` });
		probes.push({ at: fn.body.end, text: `)` });
	}
	return id;
};
const probeOf = new Map<any, number>();
for (const node of R) {
	const cls =
		node.type === 'ClassDeclaration' ? node
		: node.type === 'VariableDeclaration' ? node.declarations.find((d: any) => d.init?.type === 'ClassExpression')?.init
		: node.type === 'IfStatement' && node.consequent?.expression?.right?.type === 'ClassExpression' ? node.consequent.expression.right
		: null;
	if (cls) {
		for (const m of cls.body.body) if (m.type === 'MethodDefinition') probeOf.set(m, probe(m.value));
	} else if (node.type === 'FunctionDeclaration') probeOf.set(node, probe(node));
	else if (node.type === 'VariableDeclaration' && node.declarations.every((d: any) => d.init && /^(ArrowFunctionExpression|FunctionExpression)$/.test(d.init.type))) {
		const ids = node.declarations.map((d: any) => probe(d.init));
		probeOf.set(node, ids[0]);
		node.__ids = ids;
	}
}
let instrumented = readableSrc;
for (const p of [...probes].sort((a, b) => b.at - a.at)) instrumented = instrumented.slice(0, p.at) + p.text + instrumented.slice(p.at);
const instrumentedPath = join(dir, 'coverage-instrumented.js');
await Bun.write(instrumentedPath, instrumented);
const child = Bun.spawnSync(['bun', import.meta.path, '--run', variant, app, instrumentedPath], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
rmSync(instrumentedPath);
if (child.exitCode !== 0) throw new Error(`instrumented run failed:\n${child.stderr}`);
const fired = new Set<number>(JSON.parse(child.stdout.toString().trim().split('\n').at(-1)!));
const ran = (node: any): boolean | null => {
	const ids: number[] | undefined = node.__ids ?? (probeOf.has(node) ? [probeOf.get(node)!] : undefined);
	return ids ? ids.some((id) => fired.has(id)) : null;
};

type Row = { module: string; category: string; name: string; status: 'ran' | 'never ran' | 'unknown' | 'module init'; minBytes: number };
const rows: Row[] = [];
const size = (n: any) => Buffer.byteLength(minSrc.slice(n.start, n.end));
const isFn = (n: any) => n && /^(ArrowFunctionExpression|FunctionExpression)$/.test(n.type);
const classOf = (n: any) =>
	n.type === 'ClassDeclaration' ? n
	: n.type === 'VariableDeclaration' ? n.declarations.find((d: any) => d.init?.type === 'ClassExpression')?.init
	: n.type === 'IfStatement' && n.consequent?.expression?.right?.type === 'ClassExpression' ? n.consequent.expression.right
	: null;

let mi = -1;
R.forEach((node: any, i: number) => {
	while (mi + 1 < marks.length && marks[mi + 1].start < node.start) mi++;
	const module = mi >= 0 ? shortPath(marks[mi].value.trim()) : '?';
	const category = categorize(module);
	const m = M[i];
	const cls = classOf(node);
	const mcls = classOf(m);
	if (cls && mcls && cls.body.body.length === mcls.body.body.length) {
		const name = cls.id?.name ?? node.declarations?.[0]?.id?.name ?? 'SvelteElement';
		cls.body.body.forEach((mem: any, j: number) => {
			const key = mem.key?.type === 'PrivateIdentifier' ? `#${mem.key.name}` : (mem.key?.name ?? '?');
			const fn = mem.type === 'MethodDefinition';
			const status = fn ? ran(mem) : 'module init';
			rows.push({ module, category, name: `${name}.${key}`, status: status === null ? 'unknown' : status === true ? 'ran' : status === false ? 'never ran' : status, minBytes: size(mcls.body.body[j]) });
		});
		const overhead = size(m) - mcls.body.body.reduce((s: number, x: any) => s + size(x), 0);
		rows.push({ module, category, name: `${name} (class shell)`, status: 'module init', minBytes: overhead });
		return;
	}
	const fnLike = node.type === 'FunctionDeclaration' || (node.type === 'VariableDeclaration' && node.declarations.every((d: any) => isFn(d.init)));
	const name =
		node.type === 'FunctionDeclaration' ? node.id.name
		: node.type === 'VariableDeclaration' ? node.declarations.map((d: any) => d.id.name ?? '{…}').join(', ')
		: readableSrc.slice(node.start, Math.min(node.end, node.start + 50)).replace(/\s+/g, ' ');
	const status = fnLike ? ran(node) : 'module init';
	rows.push({ module, category, name, status: status === null ? 'unknown' : status === true ? 'ran' : status === false ? 'never ran' : status, minBytes: size(m) });
});

const total = rows.reduce((s, r) => s + r.minBytes, 0);
const byStatus: Record<string, number> = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + r.minBytes;
const cats = new Map<string, Record<string, number>>();
for (const r of rows) {
	const c = cats.get(r.category) ?? {};
	c[r.status] = (c[r.status] ?? 0) + r.minBytes;
	cats.set(r.category, c);
}

const n = (x = 0) => x.toLocaleString('en-US');
const md = [
	`# Runtime coverage: ${variant} / ${app}`,
	'',
	'Minified bytes of every top-level function / class method in main.min.js, by whether it executed while hydrating the SSR page and running the app\'s interaction test in happy-dom (probe-instrumented main.readable.js). "module init" = top-level data/statements and class fields, evaluated at load.',
	'',
	'| status | min bytes | share |',
	'| --- | ---: | ---: |',
	...Object.entries(byStatus).map(([s, b]) => `| ${s} | ${n(b)} | ${((100 * b) / total).toFixed(1)}% |`),
	`| total | ${n(total)} | |`,
	'',
	'## By category',
	'',
	'| category | ran | never ran | module init | unknown |',
	'| --- | ---: | ---: | ---: | ---: |',
	...[...cats.entries()]
		.sort((a, b) => (b[1]['never ran'] ?? 0) - (a[1]['never ran'] ?? 0))
		.map(([c, v]) => `| ${c} | ${n(v['ran'])} | ${n(v['never ran'])} | ${n(v['module init'])} | ${n(v['unknown'])} |`),
	'',
	'## Functions / methods that never ran (largest first)',
	'',
	'| name | module | min bytes |',
	'| --- | --- | ---: |',
	...rows
		.filter((r) => r.status === 'never ran')
		.sort((a, b) => b.minBytes - a.minBytes)
		.map((r) => `| \`${r.name}\` | \`${r.module}\` | ${n(r.minBytes)} |`),
	'',
	'## Functions / methods that ran',
	'',
	rows
		.filter((r) => r.status === 'ran')
		.map((r) => `\`${r.name}\``)
		.join(', ')
].join('\n');

await Bun.write(join(dir, 'coverage.json'), JSON.stringify({ variant, total, byStatus, rows }, null, 2));
await Bun.write(join(dir, 'coverage.md'), md + '\n');
console.log(md.split('\n## Functions / methods that never ran')[0]);
