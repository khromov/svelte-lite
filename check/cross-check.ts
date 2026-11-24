/**
 * Compares the check with Svelte's compiler over every component in the samples of Svelte's
 * suite. The check should find something exactly where the compiler, in runes mode and
 * without `experimental.async`, warns about deprecated syntax or fails on syntax that only
 * legacy mode has or that needs `experimental.async` (or a custom renderer), at the same
 * positions. Some syntax is deprecated without the compiler warning about it; those rules
 * are listed in `SILENT` and reported apart.
 *
 *   bun check/cross-check.ts            the summary
 *   bun check/cross-check.ts --files    every file where the two disagree
 */
import fs from 'node:fs';
import path from 'node:path';
import { compile } from '../vendor/svelte/packages/svelte/src/compiler/index.js';
import { ROOT, UPSTREAM_TESTS } from '../harness/paths.ts';
import { check, type Finding } from './index.ts';

/** Warnings of the compiler about deprecated syntax */
const is_deprecation = (code: string) => code.endsWith('_deprecated') || code.startsWith('options_deprecated_');

/** Errors of the compiler, in runes mode, about syntax of legacy mode, `await` and custom renderers */
const GATED_ERRORS = new Set([
	'legacy_export_invalid',
	'legacy_props_invalid',
	'legacy_reactive_statement_invalid',
	'legacy_rest_props_invalid',
	'attribute_invalid_sequence_expression',
	'experimental_async',
	'svelte_options_customrenderer_disabled'
]);

/**
 * Deprecated syntax that the compiler says nothing about, by rule: all findings of the rule,
 * or those that `when` picks
 */
const SILENT: Record<string, { when?: (finding: Finding) => boolean; why: string }> = {
	window_event_directive: {
		why:
			'on `<svelte:window>`, `<svelte:document>` and `<svelte:body>`, `on:` is just as deprecated, ' +
			'but the compiler only warns about it on elements'
	},
	component_event: {
		why: 'the compiler does not warn about `on:` on a component, as the component may not be the author\'s to change'
	},
	event_forwarding: {
		when: (finding) => finding.parent !== 'RegularElement' && finding.parent !== 'SvelteElement',
		why: 'forwarding from a component or `<svelte:window>`: the compiler only warns about `on:` on elements'
	}
};

interface Signal {
	code: string;
	start: number;
}

function* svelte_files(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== '_output' && entry.name !== 'node_modules') yield* svelte_files(file);
		} else if (entry.name.endsWith('.svelte')) {
			yield file;
		}
	}
}

const sample_dirs = fs
	.readdirSync(UPSTREAM_TESTS)
	.flatMap((suite) => ['samples', 'custom-elements-samples'].map((d) => path.join(UPSTREAM_TESTS, suite, d)))
	.filter((dir) => fs.existsSync(dir));

const files = sample_dirs.flatMap((dir) => [...svelte_files(dir)]).sort();

let check_time = 0;
let agree = 0;
let clean = 0;
const parse_errors: string[] = [];
const matched = new Map<string, number>();
const silent = new Map<string, string[]>();
const extra = new Map<string, string[]>();
const gaps = new Map<string, string[]>();
const after_error = new Map<string, number>();
const in_legacy_mode = new Map<string, string[]>();
const stopped: Record<string, string[]> = {};

const push = <T>(map: Map<string, T[]>, key: string, value: T) => map.set(key, [...(map.get(key) ?? []), value]);

for (const file of files) {
	const source = fs.readFileSync(file, 'utf8').replace(/\r/g, '');
	const custom_element = file.includes('custom-elements-samples');
	const relative = path.relative(UPSTREAM_TESTS, file);

	const started = performance.now();
	const findings = check(source, { filename: file, customElement: custom_element });
	check_time += performance.now() - started;

	const signals: Signal[] = [];
	/** Whether the compiler stopped at an error, and saw only part of the component */
	let failed = false;
	let legacy_mode = false;

	try {
		const result = compile(source, {
			filename: file,
			runes: true,
			generate: 'client',
			customElement: custom_element,
			warningFilter(warning) {
				if (is_deprecation(warning.code)) signals.push({ code: warning.code, start: warning.position![0] });
				return true;
			}
		});

		if (!result.metadata.runes) {
			signals.push({ code: 'legacy_mode', start: -1 });
			legacy_mode = true;
		}
	} catch (error: any) {
		failed = true;

		if (GATED_ERRORS.has(error.code)) {
			signals.push({ code: error.code, start: error.position[0] });
		} else {
			(stopped[error.code ?? 'unknown'] ??= []).push(relative);
		}
	}

	if (findings[0]?.rule === 'parse_error') {
		if (failed) parse_errors.push(relative);
		else push(extra, 'parse_error', relative);
		continue;
	}

	// a finding is matched by a signal at the same place; `runes={false}` by the compiler's
	// switching to legacy mode
	const matches = (finding: Finding, signal: Signal) =>
		signal.start === finding.start || (signal.code === 'legacy_mode' && finding.rule === 'options_runes_false');

	let disagrees = false;

	for (const finding of findings) {
		if (signals.some((signal) => matches(finding, signal))) {
			matched.set(finding.rule, (matched.get(finding.rule) ?? 0) + 1);
		} else if (failed) {
			// the compiler stops at its first error, which need not be the first in the file
			after_error.set(finding.rule, (after_error.get(finding.rule) ?? 0) + 1);
		} else if (legacy_mode && (finding.kind === 'legacy' || finding.kind === 'deprecated')) {
			// in legacy mode the compiler accepts what only it has, and warns about no deprecated syntax
			push(in_legacy_mode, finding.rule, `${relative}:${finding.line}:${finding.column}`);
		} else if (SILENT[finding.rule] && (SILENT[finding.rule].when?.(finding) ?? true)) {
			push(silent, finding.rule, `${relative}:${finding.line}:${finding.column}`);
		} else {
			push(extra, finding.rule, `${relative}:${finding.line}:${finding.column}`);
			disagrees = true;
		}
	}

	for (const signal of signals) {
		if (!findings.some((finding) => matches(finding, signal))) {
			push(gaps, signal.code, `${relative} @${signal.start}`);
			disagrees = true;
		}
	}

	if (!disagrees) agree += 1;
	if (findings.length === 0 && signals.length === 0) clean += 1;
}

const show = process.argv.includes('--files');
const list = (entries: string[]) => (show ? entries.map((e) => `\n      ${e}`).join('') : '');

console.log(`${files.length} components in the samples of ${path.relative(ROOT, UPSTREAM_TESTS)}`);
console.log(`  the check took ${Math.round(check_time)} ms for all of them (${(check_time / files.length).toFixed(2)} ms each)`);
console.log(`  ${agree} agree (${clean} with nothing to find), ${files.length - agree - parse_errors.length} do not`);
console.log(`  ${parse_errors.length} do not parse, which both report${list(parse_errors)}`);

console.log('\nFindings where the compiler warns or fails, at the same position:');
for (const [rule, n] of [...matched].sort()) console.log(`  ${String(n).padStart(5)}  ${rule}`);

console.log('\nFindings of syntax the compiler says nothing about (see SILENT):');
for (const [rule, entries] of [...silent].sort()) {
	console.log(`  ${String(entries.length).padStart(5)}  ${rule}: ${SILENT[rule].why}${list(entries)}`);
}

console.log('\nFindings in a component that selects legacy mode, where the compiler takes legacy syntax and warns about nothing deprecated (`runes={false}` is matched):');
for (const [rule, entries] of [...in_legacy_mode].sort()) console.log(`  ${String(entries.length).padStart(5)}  ${rule}${list(entries)}`);

console.log('\nFindings in a component on which the compiler failed elsewhere first, which it did not get to:');
for (const [rule, n] of [...after_error].sort()) console.log(`  ${String(n).padStart(5)}  ${rule}`);

console.log('\nDisagreements: findings where the compiler says nothing:');
if (extra.size === 0) console.log('  none');
for (const [rule, entries] of [...extra].sort()) console.log(`  ${String(entries.length).padStart(5)}  ${rule}${list(entries)}`);

console.log('\nDisagreements: what the compiler says and the check does not find (gaps):');
if (gaps.size === 0) console.log('  none');
for (const [code, entries] of [...gaps].sort()) console.log(`  ${String(entries.length).padStart(5)}  ${code}${list(entries)}`);

console.log('\nComponents on which the compiler failed for other reasons (compared up to that point):');
for (const [code, entries] of Object.entries(stopped).sort()) {
	console.log(`  ${String(entries.length).padStart(5)}  ${code}${list(entries)}`);
}

process.exit(extra.size > 0 || gaps.size > 0 ? 1 : 0);
