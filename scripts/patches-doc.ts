#!/usr/bin/env bun
/**
 * Applies every variant's patches to every file of the linked Svelte runtime (not just
 * the files one app happens to import), fails if any anchor is missing, and writes the
 * patch inventory to PATCHES.md (per-patch lines removed/added vs upstream).
 *
 *   bun scripts/patches-doc.ts            check + write PATCHES.md
 *   bun scripts/patches-doc.ts --check    check only (= bun run check.ts --anchors)
 *   --svelte=<ref>                        against another vendored Svelte (see scripts/link-svelte.ts)
 *
 * A failing patch is reported with its technique, file and reason, and the run continues,
 * so one run lists every patch that no longer applies to the selected Svelte ref. (A later
 * patch on the same file then sees the file without the failed one, which can cascade.)
 */
import { join, relative } from 'node:path';
import { readdirSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ROOT, SVELTE_DIR, assertPristine, svelteLabel, SVELTE_INFO } from './link-svelte.ts';

// Reads SVELTE_DIR directly (the patch modules only import svelte *types*), so this never
// re-points the shared node_modules/svelte symlink: safe to run for any ref, even mid-build.
assertPristine();
console.log(`patch anchors vs ${svelteLabel()}`);
const { variants } = await import('../variants.ts');
const { applyPatches } = await import('../plugins/patch.ts');
const T = await import('../patches/optimized.ts');
const M = await import('../patches/minimal.ts');

const SRC = join(SVELTE_DIR, 'src');
const files: string[] = [];
(function collect(dir: string) {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (statSync(p).isDirectory()) {
			// client runtime only: the patch plugin runs in the client build; SSR uses stock Svelte
			if (f !== 'compiler' && f !== 'server') collect(p);
		} else if (f.endsWith('.js') && !f.includes('.test.') && !/-server\.js$/.test(f)) files.push(p);
	}
})(SRC);

const tmp = mkdtempSync(join(tmpdir(), 'svelte-lite-patches-'));
function diffStat(before: string, after: string) {
	writeFileSync(join(tmp, 'a'), before);
	writeFileSync(join(tmp, 'b'), after);
	const out = Bun.spawnSync(['diff', join(tmp, 'a'), join(tmp, 'b')]).stdout.toString();
	const lines = out.split('\n');
	return { removed: lines.filter((l) => l.startsWith('< ')).length, added: lines.filter((l) => l.startsWith('> ')).length };
}

interface Row {
	technique: string;
	feature: string;
	file: string;
	why: string;
	removed: number;
	added: number;
	ops: string;
}

const TECHNIQUES: Array<[string, any]> = [
	['optimized: DEV_CONST', T.DEV_CONST],
	['optimized: PURE', T.PURE],
	['minimal: LEGACY', M.LEGACY],
	['minimal: ASYNC', M.ASYNC],
	['minimal: TRANSITIONS', M.TRANSITIONS],
	['minimal: ROOT_BOUNDARY', M.ROOT_BOUNDARY],
	['minimal: DELEGATION', M.DELEGATION],
	['minimal: PROXY', M.PROXY]
];

// Apply the full `minimal` patch list in order, one patch at a time, attributing diffs.
const minimal = variants.minimal;
const rows: Row[] = [];
const constRows = new Map<string, Row>();
let failures = 0;
const failed: Array<{ technique: string; file: string; why: string; error: string }> = [];
const fail = (p: any, file: string, error: string) => {
	failures++;
	const prefix = `[svelte-lite patch] ${file} (${p.feature}: ${p.why}): `;
	failed.push({ technique: techniqueOf(p), file, why: p.why, error: error.replace(/^Error: /, '').replace(prefix, '') });
};

const techniqueOf = (p: any) => TECHNIQUES.find(([, t]) => t.patches?.includes(p))?.[0] ?? '?';
const opsOf = (p: any) =>
	[
		p.replace?.length ? `${p.replace.length} text edit${p.replace.length > 1 ? 's' : ''}` : '',
		p.removeMembers ? `remove ${p.removeMembers.members.length} ${p.removeMembers.class} member${p.removeMembers.members.length > 1 ? 's' : ''}` : '',
		p.removeFunctions ? `remove fn ${p.removeFunctions.join(', ')}` : '',
		p.replaceFunctions ? `replace fn ${Object.keys(p.replaceFunctions).join(', ')} (hash-pinned)` : '',
		p.prepend ? 'prepend' : ''
	]
		.filter(Boolean)
		.join('; ');

for (const path of files) {
	const rel = relative(SVELTE_DIR, path);
	let code = await Bun.file(path).text();
	for (const p of minimal.patches ?? []) {
		if (typeof p.file === 'string' ? p.file !== rel : !p.file.test(rel)) continue;
		try {
			const { code: next } = await applyPatches(path, code, { svelteDir: SVELTE_DIR, patches: [p] });
			if (next !== code) {
				const { removed, added } = diffStat(code, next);
				rows.push({ technique: techniqueOf(p), feature: p.feature, file: rel, why: p.why, removed, added, ops: opsOf(p) });
			}
			code = next;
		} catch (e) {
			fail(p, rel, String(e));
		}
	}
	// constImports (hoisted consts): one row per rule, lines = that rule applied alone
	for (const rule of minimal.constImports ?? []) {
		const { code: next } = await applyPatches(path, code, { svelteDir: SVELTE_DIR, constImports: [rule] });
		if (next === code) continue;
		const { removed, added } = diffStat(code, next);
		const key = `${rule.feature}: ${Object.keys(rule.values).join(', ')}`;
		const r = constRows.get(key) ?? { technique: `constImports (${rule.feature})`, feature: rule.feature ?? 'const', file: '', why: rule.why ?? '', removed: 0, added: 0, ops: `import { ${Object.keys(rule.values).join(', ')} } from '${rule.from}' → hoisted const` };
		r.file = r.file ? `${r.file}, ${rel.replace(/^src\//, '')}` : rel.replace(/^src\//, '');
		r.removed += removed;
		r.added += added;
		constRows.set(key, r);
	}
	code = (await applyPatches(path, code, { svelteDir: SVELTE_DIR, constImports: minimal.constImports })).code;
}
rmSync(tmp, { recursive: true, force: true });

// optional (regex-file) patches must still apply somewhere, and every named file must exist
const relFiles = new Set(files.map((f) => relative(SVELTE_DIR, f)));
for (const p of minimal.patches ?? []) {
	if (typeof p.file === 'string' && !relFiles.has(p.file)) fail(p, p.file, 'file not found in this Svelte version (renamed or removed upstream?)');
	else if (typeof p.file !== 'string' && !rows.some((r) => r.why === p.why)) fail(p, String(p.file), 'did not apply to any file');
}
// a constImports rule that matches nothing is a silent no-op in the build: report it
for (const rule of minimal.constImports ?? []) {
	const key = `${rule.feature}: ${Object.keys(rule.values).join(', ')}`;
	if (!constRows.has(key)) console.warn(`warning: constImports rule ${key} (from '${rule.from}') matched no import in any runtime file`);
}

if (failures) {
	const n = minimal.patches?.length ?? 0;
	const bad = new Set(failed.map((f) => f.why));
	console.error(`\n${bad.size} of ${n} patches FAIL against svelte ${SVELTE_INFO.version} (${SVELTE_INFO.tag ?? SVELTE_INFO.ref} @ ${SVELTE_INFO.sha?.slice(0, 12)}):`);
	for (const f of failed) console.error(`  FAIL ${f.technique.padEnd(22)} ${f.file.replace(/^src\//, '')}  ${f.why}\n       -> ${f.error}`);
	process.exit(1);
}
console.log(`all ${minimal.patches?.length} minimal patches (incl. optimized) apply cleanly to ${files.length} runtime files`);
if (process.argv.includes('--check')) process.exit(0);

// ---------------------------------------------------------------------------------------------
const md: string[] = [];
const esc = (s: string) => s.replace(/\|/g, '\\|');
const byTechnique = new Map<string, Row[]>();
for (const r of rows) {
	if (!byTechnique.has(r.technique)) byTechnique.set(r.technique, []);
	byTechnique.get(r.technique)!.push(r);
}
const sum = (rs: Row[], k: 'removed' | 'added') => rs.reduce((s, r) => s + r[k], 0);
const constList = [...constRows.values()];

md.push(`<!-- generated by scripts/patches-doc.ts; do not edit by hand -->`);
md.push(
	`Generated against Svelte ${SVELTE_INFO.version}: \`${SVELTE_INFO.tag ?? SVELTE_INFO.ref}\` @ \`${SVELTE_INFO.sha ?? 'unknown'}\` from ${SVELTE_INFO.repo ?? 'an unknown repo'}` +
		`${SVELTE_INFO.dirty ? ' **with local changes**' : ''} (\`${SVELTE_INFO.path}\`, selected via ${SVELTE_INFO.via}).`,
	''
);
md.push(`## Summary`, '');
md.push(`| technique | variant | patches | files | upstream lines removed | lines added |`, `| --- | --- | ---: | ---: | ---: | ---: |`);
const variantOf = (name: string) => (name.startsWith('optimized') || name.includes('(dev)') ? 'optimized' : 'minimal');
const summaryRows: Array<[string, number, Row[]]> = [];
for (const [name, t] of TECHNIQUES) summaryRows.push([name, t.patches?.length ?? 0, byTechnique.get(name) ?? []]);
for (const r of constList) summaryRows.push([r.technique + ` (${r.ops.match(/\{ (.*) \}/)?.[1]})`, 1, [r]]);
for (const [name, defs, rs] of summaryRows) {
	const nFiles = new Set(rs.flatMap((r) => r.file.split(', '))).size;
	md.push(`| ${name} | ${variantOf(name)} | ${defs} | ${nFiles} | ${sum(rs, 'removed')} | ${sum(rs, 'added')} |`);
}
const totals = (v: string) => {
	const rs = summaryRows.filter(([n]) => v === 'minimal' || variantOf(n) === 'optimized');
	const all = rs.flatMap(([, , r]) => r);
	return `${rs.reduce((s, [, d]) => s + d, 0)} patches, ${new Set(all.flatMap((r) => r.file.split(', ').map((f) => f.replace(/^src\//, '')))).size} files, −${sum(all, 'removed')} / +${sum(all, 'added')} lines`;
};
md.push('', `- **optimized**: ${totals('optimized')} (plus the compiled-output transforms and options listed above).`);
md.push(`- **minimal** (includes optimized): ${totals('minimal')}.`, '');

md.push(`## Every source patch`, '');
md.push(`Lines are counted with \`diff\` against the file as it was before that patch (patches apply in this order).`, '');
md.push(`| variant | technique | file (\`src/…\`) | ops | −/+ lines | what & why |`, `| --- | --- | --- | --- | ---: | --- |`);
for (const r of rows) {
	const [variant, technique] = r.technique.split(': ');
	md.push(`| ${variant} | ${technique} | \`${r.file.replace(/^src\//, '')}\` | ${r.ops} | −${r.removed} / +${r.added} | ${esc(r.why)} |`);
}
for (const r of constList) {
	md.push(`| ${r.feature === 'dev' ? 'optimized' : 'minimal'} | ${r.technique} | ${r.file.split(', ').length} files: ${r.file.split(', ').map((f) => `\`${f}\``).join(', ')} | ${esc(r.ops)} | −${r.removed} / +${r.added} | ${esc(r.why)} |`);
}

const out = join(ROOT, 'PATCHES.md');
const existing = await Bun.file(out).text().catch(() => '');
const marker = '<!-- generated by scripts/patches-doc.ts; do not edit by hand -->';
const head = existing.includes(marker) ? existing.slice(0, existing.indexOf(marker)) : '# PATCHES\n\n';
await Bun.write(out, head + md.join('\n') + '\n');
console.log(`wrote ${out}`);
