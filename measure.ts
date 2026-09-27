#!/usr/bin/env bun
/**
 * Size measurement + attribution for a built variant.
 *
 *   bun run measure.ts [variant ...]          re-measure dist/<variant> (default: baseline)
 *   bun run measure.ts --compare a b [c ...]  compare report.json of built variants (first = reference)
 *
 * Writes dist/<variant>/report.json and report.md:
 *   - sizes:        raw / gzip (level 9) / brotli (q11) for every emitted .js/.css
 *   - modules:      per-input-module bytes from Bun's metafile (bytesInOutput), for the
 *                   minified and unminified builds, plus the *marginal* gzip/brotli cost of
 *                   each module in the minified bundle (size(all) - size(all without it))
 *   - categories:   the same rolled up by feature area (see CATEGORIES)
 *   - declarations: every top-level statement of the minified bundle, mapped back to its
 *                   readable name + source module (main.readable.js and main.min.js are
 *                   produced with identical DCE, so their top-level statements align 1:1)
 */
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, SVELTE_DIR, SVELTE_INFO, type SvelteInfo } from './scripts/link-svelte.ts';

/** Build output root: dist/, or build.ts --out=<dir> (passed down as SVELTE_LITE_DIST). */
const DIST = resolve(ROOT, process.env.SVELTE_LITE_DIST ?? 'dist');

// acorn/zimmerframe come from the Svelte checkout's node_modules (no extra deps here).
const acorn: any = await import(Bun.resolveSync('acorn', join(SVELTE_DIR, 'src')));

// ---------------------------------------------------------------------------------------------
// compression helpers

export const gzip = (b: Uint8Array | string) => gzipSync(b, { level: 9 }).length;
export const brotli = (b: Uint8Array | string) =>
	brotliCompressSync(b, {
		params: {
			[constants.BROTLI_PARAM_QUALITY]: 11,
			[constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
			[constants.BROTLI_PARAM_SIZE_HINT]: typeof b === 'string' ? Buffer.byteLength(b) : b.length
		}
	}).length;
const bytes = (s: string) => Buffer.byteLength(s);

// ---------------------------------------------------------------------------------------------
// feature categories for Svelte runtime modules (first match wins)

export const CATEGORIES: Array<[string, RegExp]> = [
	['app', /^apps\//],
	['esm-env', /esm-env/],
	['dev-only', /svelte\/src\/internal\/(client\/dev\/|shared\/dev\.js|client\/validate\.js)/],
	['warnings', /svelte\/src\/internal\/(client|shared)\/warnings\.js/],
	['errors', /svelte\/src\/internal\/(client|shared)\/errors\.js/],
	['legacy', /svelte\/src\/(legacy\/|internal\/client\/(legacy\.js|dom\/legacy\/|reactivity\/store\.js))/],
	['custom-element', /custom-element\.js/],
	['hydration', /dom\/hydration\.js/],
	['boundary/async', /dom\/blocks\/(boundary|async)\.js|reactivity\/async\.js|error-handling\.js/],
	['batch/scheduling', /reactivity\/batch\.js|dom\/task\.js|timing\.js|reactivity\/status\.js/],
	['effects', /reactivity\/effects\.js/],
	['signals (sources/deriveds/runtime)', /reactivity\/(sources|deriveds|equality|utils)\.js|client\/runtime\.js|client\/context\.js/],
	['proxy ($state objects)', /client\/proxy\.js/],
	['mount/render', /client\/render\.js/],
	['events', /dom\/elements\/events\.js/],
	['template/dom ops', /dom\/(template|operations|reconciler)\.js/],
	['dom elements/bindings/blocks', /dom\/(elements|blocks)\//],
	['version/disclose', /disclose-version\.js|svelte\/src\/version\.js/],
	['public api (svelte, svelte/reactivity)', /svelte\/src\/(index-client|reactivity\/|utils\.js)/],
	['shared utils/constants', /svelte\/src\/(internal\/shared|constants\.js|internal\/client\/constants\.js|internal\/flags)/],
	['other svelte', /svelte\//]
];
export const categorize = (p: string) => CATEGORIES.find(([, re]) => re.test(p))?.[0] ?? 'other';

/**
 * Location-independent module names: '<anything>/packages/svelte/src/x.js' -> 'svelte/src/x.js'
 * (vendor/svelte/<ref>/…, ../svelte/…, any SVELTE_DIR), and a dependency anywhere under a
 * node_modules (incl. pnpm's .pnpm/<pkg>@<v>/node_modules/) -> 'esm-env/x.js'.
 */
export const shortPath = (p: string) =>
	p
		.replace(/^.*?packages\/svelte\//, 'svelte/')
		.replace(/^.*node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?/, '');

// ---------------------------------------------------------------------------------------------
// top-level statement attribution

interface Decl {
	index: number;
	module: string;
	names: string;
	kind: string;
	minBytes: number;
	readableBytes: number;
	/** gzip size of bundle minus gzip size of bundle without this statement */
	gzipMarginal?: number;
	start: number;
	end: number;
	/** For classes: per-member breakdown (class members can't be tree-shaken individually). */
	members?: Array<{ name: string; kind: string; minBytes: number; gzipMarginal?: number; start: number; end: number }>;
}

function classBody(node: any): any | null {
	if (node.type === 'ClassDeclaration') return node.body;
	if (node.type === 'VariableDeclaration') {
		for (const d of node.declarations) if (d.init?.type === 'ClassExpression') return d.init.body;
	}
	if (node.type === 'IfStatement') {
		// custom-element.js: if (typeof HTMLElement === 'function') SvelteElement = class ...
		const e = node.consequent?.expression ?? node.consequent?.body?.[0]?.expression;
		if (e?.type === 'AssignmentExpression' && e.right.type === 'ClassExpression') return e.right.body;
	}
	return null;
}

function memberName(m: any, src: string) {
	if (m.type === 'StaticBlock') return 'static {}';
	const key = m.key.type === 'PrivateIdentifier' ? `#${m.key.name}` : m.computed ? `[${src.slice(m.key.start, m.key.end)}]` : (m.key.name ?? m.key.value);
	return `${m.static ? 'static ' : ''}${key}`;
}

function describe(node: any, src: string): { names: string; kind: string } {
	switch (node.type) {
		case 'FunctionDeclaration':
			return { names: node.id.name, kind: 'function' };
		case 'ClassDeclaration':
			return { names: node.id.name, kind: 'class' };
		case 'VariableDeclaration':
			return {
				names: node.declarations
					.map((d: any) => (d.id.type === 'Identifier' ? d.id.name : src.slice(d.id.start, d.id.end)))
					.join(', '),
				kind: node.kind
			};
		default: {
			const text = src.slice(node.start, node.end).replace(/\s+/g, ' ');
			return { names: text.length > 70 ? text.slice(0, 67) + '...' : text, kind: `side-effect:${node.type}` };
		}
	}
}

function parse(src: string, comments?: any[]) {
	return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments }) as any;
}

export function declarations(readableSrc: string, minSrc: string): Decl[] | null {
	const comments: any[] = [];
	const readable = parse(readableSrc, comments).body;
	const min = parse(minSrc).body;
	if (readable.length !== min.length) {
		console.warn(`[measure] statement count mismatch readable=${readable.length} min=${min.length}; skipping declaration map`);
		return null;
	}
	const moduleMarks = comments
		.filter((c) => c.type === 'Line' && /^ (\.\.\/|src\/|\S+\.(js|svelte|ts)$)/.test(c.value))
		.map((c) => ({ pos: c.start, path: c.value.trim() }));
	let mi = -1;
	return readable.map((node: any, i: number) => {
		while (mi + 1 < moduleMarks.length && moduleMarks[mi + 1].pos < node.start) mi++;
		const m = min[i];
		const decl: Decl = {
			index: i,
			module: mi >= 0 ? shortPath(moduleMarks[mi].path) : '?',
			...describe(node, readableSrc),
			minBytes: bytes(minSrc.slice(m.start, m.end)),
			readableBytes: bytes(readableSrc.slice(node.start, node.end)),
			start: m.start,
			end: m.end
		};
		const rb = classBody(node);
		const mb = classBody(m);
		if (rb && mb && rb.body.length === mb.body.length) {
			decl.members = rb.body.map((rm: any, j: number) => {
				const mm = mb.body[j];
				return {
					name: memberName(rm, readableSrc),
					kind: rm.type === 'MethodDefinition' ? rm.kind : rm.type === 'PropertyDefinition' ? 'field' : rm.type,
					minBytes: bytes(minSrc.slice(mm.start, mm.end)),
					start: mm.start,
					end: mm.end
				};
			});
		}
		return decl;
	});
}

/** Size of `src` with the given [start,end) ranges cut out. */
function without(src: string, ranges: Array<[number, number]>) {
	const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
	let out = '';
	let pos = 0;
	for (const [s, e] of sorted) {
		out += src.slice(pos, s);
		pos = e;
	}
	return out + src.slice(pos);
}

// ---------------------------------------------------------------------------------------------

export interface Report {
	variant: string;
	app: string;
	svelteVersion: string;
	/** exact Svelte source the bundle was built from (see scripts/link-svelte.ts) */
	svelte: Pick<SvelteInfo, 'repo' | 'ref' | 'tag' | 'sha' | 'version' | 'dirty'>;
	bunVersion: string;
	/** what bundled it: "Bun 1.4.2" (build.ts) or "Vite 8.3.1 (Rolldown …)" (build-vite.ts); absent in older reports = Bun */
	bundler?: string;
	sizes: Record<string, { raw: number; gzip: number; brotli: number }>;
	modules: Array<{
		module: string;
		category: string;
		min: number;
		unmin: number;
		readable: number;
		gzipMarginal: number;
		brotliMarginal: number;
	}>;
	categories: Array<{ category: string; min: number; unmin: number; gzipMarginal: number; brotliMarginal: number; modules: number }>;
	declarations: Decl[] | null;
}

function sumBy(decls: Decl[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const d of decls) out[d.module] = (out[d.module] ?? 0) + d.minBytes;
	return out;
}

function metaInputs(outdir: string, mode: string): Record<string, number> {
	const file = join(outdir, `meta.${mode}.json`);
	if (!existsSync(file)) return {};
	const meta = JSON.parse(readFileSync(file, 'utf8'));
	const out: Record<string, number> = {};
	for (const [path, o] of Object.entries<any>(meta.outputs)) {
		if (!path.endsWith('.js')) continue;
		for (const [input, { bytesInOutput }] of Object.entries<any>(o.inputs)) {
			const k = shortPath(input);
			out[k] = (out[k] ?? 0) + bytesInOutput;
		}
	}
	return out;
}

export async function measure(variant: string, app: string, outdir = join(DIST, variant, app), { print = false, bundler = `Bun ${Bun.version}` } = {}) {
	const sizes: Report['sizes'] = {};
	for (const f of readdirSync(outdir).sort()) {
		if (!/^main.*\.(js|css)$/.test(f)) continue;
		const buf = new Uint8Array(await Bun.file(join(outdir, f)).arrayBuffer());
		sizes[f] = { raw: buf.length, gzip: gzip(buf), brotli: brotli(buf) };
	}

	const minSrc = await Bun.file(join(outdir, 'main.min.js')).text();
	const readableSrc = await Bun.file(join(outdir, 'main.readable.js')).text();
	const decls = declarations(readableSrc, minSrc);

	// Per-module minified bytes: from the aligned declaration map when available (exact, and
	// still correct after postpass.ts re-bundled main.min.js), else from Bun's metafile.
	const min = decls ? sumBy(decls) : metaInputs(outdir, 'min');
	const unmin = metaInputs(outdir, 'unmin');
	const readable = metaInputs(outdir, 'readable');
	const totalGz = gzip(minSrc);
	const totalBr = brotli(minSrc);

	// marginal cost per module / per category, from the aligned statement map
	const rangesBy = (key: (d: Decl) => string) => {
		const m = new Map<string, Array<[number, number]>>();
		for (const d of decls ?? []) {
			const k = key(d);
			if (!m.has(k)) m.set(k, []);
			m.get(k)!.push([d.start, d.end]);
		}
		return m;
	};
	const marginal = (ranges: Array<[number, number]> | undefined) => {
		if (!ranges?.length) return { gz: 0, br: 0 };
		const rest = without(minSrc, ranges);
		return { gz: totalGz - gzip(rest), br: totalBr - brotli(rest) };
	};

	const byModule = rangesBy((d) => d.module);
	const moduleNames = new Set([...Object.keys(min), ...Object.keys(unmin)]);
	const modules: Report['modules'] = [...moduleNames]
		.map((module) => {
			const mg = marginal(byModule.get(module));
			return {
				module,
				category: categorize(module),
				min: min[module] ?? 0,
				unmin: unmin[module] ?? 0,
				readable: readable[module] ?? 0,
				gzipMarginal: mg.gz,
				brotliMarginal: mg.br
			};
		})
		.sort((a, b) => b.min - a.min || b.unmin - a.unmin);

	const byCategory = rangesBy((d) => categorize(d.module));
	const catMap = new Map<string, Report['categories'][number]>();
	for (const m of modules) {
		const c = catMap.get(m.category) ?? { category: m.category, min: 0, unmin: 0, gzipMarginal: 0, brotliMarginal: 0, modules: 0 };
		c.min += m.min;
		c.unmin += m.unmin;
		c.modules += m.min > 0 ? 1 : 0;
		catMap.set(m.category, c);
	}
	for (const c of catMap.values()) {
		const mg = marginal(byCategory.get(c.category));
		c.gzipMarginal = mg.gz;
		c.brotliMarginal = mg.br;
	}
	const categories = [...catMap.values()].sort((a, b) => b.min - a.min);

	if (decls)
		for (const d of decls) {
			d.gzipMarginal = marginal([[d.start, d.end]]).gz;
			for (const m of d.members ?? []) m.gzipMarginal = marginal([[m.start, m.end]]).gz;
		}

	const report: Report = {
		variant,
		app,
		svelteVersion: (await Bun.file(join(SVELTE_DIR, 'package.json')).json()).version,
		svelte: svelteProvenance(),
		bunVersion: Bun.version,
		bundler,
		sizes,
		modules,
		categories,
		declarations: decls
	};
	await Bun.write(join(outdir, 'report.json'), JSON.stringify(report, null, 2));
	const md = renderMarkdown(report);
	await Bun.write(join(outdir, 'report.md'), md);
	if (print) console.log(renderSummary(report));
	return report;
}

// ---------------------------------------------------------------------------------------------
// provenance

export const svelteProvenance = (): Report['svelte'] => {
	const { repo, ref, tag, sha, version, dirty } = SVELTE_INFO;
	return { repo, ref, tag, sha, version, ...(dirty ? { dirty } : {}) };
};

/** e.g. "svelte@5.57.1, 636eaaaa6f06, https://github.com/sveltejs/svelte.git" */
export const provenanceText = (s: Report['svelte']) =>
	[s.tag ?? s.ref, s.sha?.slice(0, 12), s.repo, s.dirty ? 'WITH LOCAL CHANGES' : ''].filter(Boolean).join(', ');

// ---------------------------------------------------------------------------------------------
// rendering

const n = (x: number) => x.toLocaleString('en-US');
const pct = (x: number, total: number) => (total ? ((100 * x) / total).toFixed(1) + '%' : '-');

function table(head: string[], rows: Array<Array<string | number>>, align?: string) {
	const a = align ?? head.map((_, i) => (i === 0 ? 'l' : 'r')).join('');
	const sep = [...a].map((c) => (c === 'r' ? '---:' : '---'));
	return [
		`| ${head.join(' | ')} |`,
		`| ${sep.join(' | ')} |`,
		...rows.map((r) => `| ${r.map((c) => (typeof c === 'number' ? n(c) : c)).join(' | ')} |`)
	].join('\n');
}

export function sizeTable(r: Report) {
	return table(
		['file', 'raw', 'gzip', 'brotli'],
		Object.entries(r.sizes).map(([f, s]) => [f, s.raw, s.gzip, s.brotli])
	);
}

export function renderSummary(r: Report) {
	const total = r.sizes['main.min.js']?.raw ?? 0;
	const lines = [
		sizeTable(r),
		'',
		'categories (minified bytesInOutput; marginal = what removing it would save, compressed):',
		table(
			['category', 'min', '%', 'gzip Δ', 'brotli Δ'],
			r.categories.filter((c) => c.min > 0).map((c) => [c.category, c.min, pct(c.min, total), c.gzipMarginal, c.brotliMarginal])
		)
	];
	return lines.join('\n');
}

export function renderMarkdown(r: Report) {
	const total = r.sizes['main.min.js']?.raw ?? 0;
	const out = [
		`# ${r.variant} / ${r.app}`,
		'',
		`Svelte ${r.svelteVersion}${r.svelte ? ` (${provenanceText(r.svelte)})` : ''}, ${r.bundler ?? `Bun ${r.bunVersion}`}`,
		'',
		'## Sizes',
		'',
		sizeTable(r),
		'',
		'## By category',
		'',
		'`min`/`unmin` are Bun metafile `bytesInOutput`. `gzip Δ`/`brotli Δ` are marginal: compressed size of main.min.js minus compressed size with that category\'s top-level statements cut out.',
		'',
		table(
			['category', 'modules', 'min', '% of min', 'unmin', 'gzip Δ', 'brotli Δ'],
			r.categories.filter((c) => c.min + c.unmin > 0).map((c) => [c.category, c.modules, c.min, pct(c.min, total), c.unmin, c.gzipMarginal, c.brotliMarginal])
		),
		'',
		'## By module',
		'',
		table(
			['module', 'category', 'min', '% of min', 'readable', 'unmin', 'gzip Δ', 'brotli Δ'],
			r.modules.filter((m) => m.min + m.unmin + m.readable > 0).map((m) => [
				'`' + m.module + '`',
				m.category,
				m.min,
				pct(m.min, total),
				m.readable,
				m.unmin,
				m.gzipMarginal,
				m.brotliMarginal
			]),
			'llrrrrrr'
		),
		'',
		'Parsed but fully tree-shaken (0 bytes in every build): ' +
			r.modules
				.filter((m) => m.min + m.unmin + m.readable === 0)
				.map((m) => '`' + m.module.replace(/^svelte\/src\//, '') + '`')
				.join(', ')
	];
	if (r.declarations) {
		out.push(
			'',
			'## Top-level declarations (minified bytes, largest first)',
			'',
			table(
				['#', 'name(s)', 'kind', 'module', 'min', 'gzip Δ'],
				[...r.declarations]
					.sort((a, b) => b.minBytes - a.minBytes)
					.map((d) => [d.index, '`' + d.names.replace(/\|/g, '\\|').replace(/`/g, "'") + '`', d.kind, '`' + d.module + '`', d.minBytes, d.gzipMarginal ?? '']),
				'rlllrr'
			)
		);
		for (const d of r.declarations.filter((d) => d.members?.length)) {
			out.push(
				'',
				`### class members: \`${d.names}\` (${d.module}, ${n(d.minBytes)} B min)`,
				'',
				'Class members are never tree-shaken individually, even when unreferenced.',
				'',
				table(
					['member', 'kind', 'min', 'gzip Δ'],
					[...d.members!].sort((a, b) => b.minBytes - a.minBytes).map((m) => ['`' + m.name + '`', m.kind, m.minBytes, m.gzipMarginal ?? '']),
					'llrr'
				)
			);
		}
	}
	return out.join('\n') + '\n';
}

export async function loadReport(variant: string, app: string): Promise<Report> {
	const f = join(DIST, variant, app, 'report.json');
	if (!existsSync(f)) throw new Error(`no report for ${variant}/${app}; run: bun run build.ts ${variant}`);
	return Bun.file(f).json();
}

/** Size table (main.min.js) for each app x variant, deltas vs the first variant. */
export async function compare(names: string[], apps: string[]) {
	const rows: Array<Array<string | number>> = [];
	for (const app of apps) {
		const ref = (await loadReport(names[0], app)).sizes['main.min.js'];
		for (const name of names) {
			const s = (await loadReport(name, app)).sizes['main.min.js'];
			const d = (x: number, y: number) => (name === names[0] ? '' : ` (${x - y >= 0 ? '+' : ''}${n(x - y)}, ${pct(x - y, y)})`);
			rows.push([app, name, n(s.raw) + d(s.raw, ref.raw), n(s.gzip) + d(s.gzip, ref.gzip), n(s.brotli) + d(s.brotli, ref.brotli)]);
		}
	}
	return table(['app', 'variant', 'main.min.js raw', 'gzip', 'brotli'], rows, 'llrrr');
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const appFlag = args.find((a) => a.startsWith('--app='))?.slice(6);
	const names = args.filter((a) => !a.startsWith('--'));
	const apps = appFlag ? [appFlag] : readdirSync(join(ROOT, 'apps')).filter((a) => existsSync(join(ROOT, 'apps', a, 'client.js')));
	if (args.includes('--compare')) {
		console.log(await compare(names, apps));
	} else {
		for (const name of names.length ? names : ['baseline']) {
			for (const app of apps) {
				console.log(`\n=== ${name}/${app} ===`);
				await measure(name, app, resolve(DIST, name, app), { print: true });
			}
		}
	}
}
