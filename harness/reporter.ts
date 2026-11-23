import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, SerializedError, TestModule, Vitest } from 'vitest/node';
import { RESULTS, ROOT, UPSTREAM_PKG, UPSTREAM_ROOT, type Impl } from './paths.ts';
import { read_package } from './resolve.ts';

type State = 'passed' | 'failed' | 'skipped';

interface Suite {
	passed: number;
	failed: number;
	skipped: number;
	/** Errors outside of any test, e.g. a test file that could not be loaded */
	errors: string[];
}

export interface Results {
	impl: Impl;
	upstream: { commit: string; version: string };
	finished: string;
	suites: Record<string, Suite>;
	/** Every test by `suite > name` */
	tests: Record<string, State>;
}

export function results_file(impl: Impl) {
	return path.join(RESULTS, `${impl}.json`);
}

export function read_results(impl: Impl): Results | null {
	try {
		return JSON.parse(fs.readFileSync(results_file(impl), 'utf8'));
	} catch {
		return null;
	}
}

export function upstream_info() {
	return {
		commit: execFileSync('git', ['-C', UPSTREAM_ROOT, 'rev-parse', 'HEAD'], {
			encoding: 'utf8'
		}).trim(),
		version: read_package(UPSTREAM_PKG).version
	};
}

/** `tests/runtime-runes/test.ts` → `runtime-runes`, `src/reactivity/set.test.ts` → `src/reactivity/set` */
export function suite_name(module_id: string) {
	const relative = path.relative(UPSTREAM_PKG, module_id);
	const sample_suite = /^tests\/([^/]+)\/test\.ts$/.exec(relative);

	return sample_suite?.[1] ?? relative.replace(/^tests\//, '').replace(/(\.test)?\.ts$/, '');
}

function headline(error: SerializedError) {
	const message = String(error.message ?? error).split('\n')[0].replaceAll(ROOT, '.');
	const text = error.name && error.name !== 'Error' ? `${error.name}: ${message}` : message;

	return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

const format = (n: number) => n.toLocaleString('en-US');
const percent = (n: number, total: number) => (total ? `${((n / total) * 100).toFixed(1)}%` : '–');

/**
 * Prints one line per test file while running, then a per-suite scoreboard, and
 * records the outcome of every test in `.results/<impl>.json`.
 */
export default class SummaryReporter implements Reporter {
	private vitest!: Vitest;

	constructor(private impl: Impl) {}

	onInit(vitest: Vitest) {
		this.vitest = vitest;
	}

	onTestModuleEnd(module: TestModule) {
		const tests = [...module.children.allTests()];
		const passed = tests.filter((test) => test.result().state === 'passed').length;
		const seconds = (module.diagnostic().duration / 1000).toFixed(1);
		const project = module.project.name === 'svelte' ? '' : ` [${module.project.name}]`;

		this.vitest.logger.log(
			` ${module.ok() ? '✓' : '✗'} ${suite_name(module.moduleId)}${project}  ` +
				`${format(passed)}/${format(tests.length)} passed  ${seconds}s`
		);
	}

	onTestRunEnd(modules: ReadonlyArray<TestModule>, unhandled: ReadonlyArray<SerializedError>) {
		const results: Results = {
			impl: this.impl,
			upstream: upstream_info(),
			finished: new Date().toISOString(),
			suites: {},
			tests: {}
		};

		const messages = new Map<string, number>();

		// shards of a suite finish in any order, the record should not depend on it
		const ordered = [...modules].sort(
			(a, b) => a.moduleId.localeCompare(b.moduleId) || a.project.name.localeCompare(b.project.name)
		);

		for (const module of ordered) {
			const name = suite_name(module.moduleId);
			const suite = (results.suites[name] ??= { passed: 0, failed: 0, skipped: 0, errors: [] });

			// errors of the module itself, and of `describe` blocks whose hooks failed
			for (const group of [module, ...module.children.allSuites()]) {
				suite.errors.push(...group.errors().map(headline));
			}

			for (const test of module.children.allTests()) {
				const result = test.result();
				const state: State = result.state === 'pending' ? 'skipped' : result.state;

				// a few tests share a name with another one in the same file
				let key = `${name} > ${test.fullName}`;
				for (let n = 2; key in results.tests; n += 1) key = `${name} > ${test.fullName} (${n})`;

				suite[state] += 1;
				results.tests[key] = state;

				if (result.state === 'failed') {
					const message = result.errors[0] ? headline(result.errors[0]) : '(no error)';
					messages.set(message, (messages.get(message) ?? 0) + 1);
				}
			}
		}

		// a filtered run says nothing about the suite as a whole, so it is not recorded
		const filtered =
			!!process.env.FILTER ||
			!!this.vitest.getGlobalTestNamePattern() ||
			!!this.vitest.config.project?.length ||
			// positional CLI filters, which vitest does not expose publicly
			!!(this.vitest as unknown as { filenamePattern?: string[] }).filenamePattern;

		const baseline = this.impl === 'lite' ? read_results('upstream') : null;

		this.print(results, baseline, messages, unhandled.length, filtered);

		if (!filtered) {
			fs.mkdirSync(RESULTS, { recursive: true });
			fs.writeFileSync(results_file(this.impl), JSON.stringify(results, null, '\t'));
		}
	}

	private print(
		results: Results,
		baseline: Results | null,
		messages: Map<string, number>,
		unhandled: number,
		filtered: boolean
	) {
		const log = (line = '') => this.vitest.logger.log(line);
		const names = Object.keys(results.suites).sort();
		const total = { passed: 0, failed: 0, skipped: 0, errors: 0, baseline: 0 };

		// per-suite upstream numbers only line up when both runs cover the whole suite
		const compare = baseline && !filtered ? baseline : null;

		const rows = names.map((name) => {
			const suite = results.suites[name];
			const expected = compare?.suites[name]?.passed;

			total.passed += suite.passed;
			total.failed += suite.failed;
			total.skipped += suite.skipped;
			total.errors += suite.errors.length;
			total.baseline += expected ?? 0;

			return [
				name,
				format(suite.passed),
				format(suite.failed),
				format(suite.skipped),
				suite.errors.length ? format(suite.errors.length) : '',
				expected === undefined ? '' : format(expected)
			];
		});

		rows.unshift(['suite', 'passed', 'failed', 'skipped', 'errors', compare ? 'upstream' : '']);
		rows.push([
			'total',
			format(total.passed),
			format(total.failed),
			format(total.skipped),
			total.errors ? format(total.errors) : '',
			compare ? format(total.baseline) : ''
		]);

		const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
		const line = (row: string[]) =>
			row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ');
		const rule = '─'.repeat(line(rows[0]).length);

		log();
		log(`${results.impl} against svelte@${results.upstream.version} tests`);
		log(rule);
		log(line(rows[0]));
		log(rule);
		for (const row of rows.slice(1, -1)) log(line(row));
		log(rule);
		log(line(rows[rows.length - 1]));
		log();

		const failing = names.filter((name) => results.suites[name].errors.length > 0);

		if (failing.length > 0) {
			log('Errors outside of tests (a file that fails to load registers no tests):');

			for (const name of failing) {
				const errors = [...new Set(results.suites[name].errors)];
				for (const error of errors.slice(0, 3)) log(`  ${name}: ${error}`);
				if (errors.length > 3) log(`  ${name}: … and ${errors.length - 3} more`);
			}

			log();
		}

		if (messages.size > 0) {
			const sorted = [...messages].sort((a, b) => b[1] - a[1]);
			const width = format(sorted[0][1]).length;

			log('Most common failures:');
			for (const [message, count] of sorted.slice(0, 12)) {
				log(`  ${format(count).padStart(width)}× ${message}`);
			}
			if (sorted.length > 12) log(`  … and ${format(sorted.length - 12)} other distinct messages`);
			log();
		}

		const ran = total.passed + total.failed;
		log(`${format(total.passed)} of ${format(ran)} tests passed (${percent(total.passed, ran)})`);

		if (unhandled > 0) log(`${format(unhandled)} unhandled errors`);

		if (filtered) {
			log('Filtered run, results not recorded');
		} else if (compare) {
			const expected = Object.keys(compare.tests).filter((key) => compare.tests[key] === 'passed');
			const matched = expected.filter((key) => results.tests[key] === 'passed').length;

			log(
				`Parity: ${format(matched)} of the ${format(expected.length)} tests ` +
					`that pass upstream (${percent(matched, expected.length)})`
			);

			if (compare.upstream.commit !== results.upstream.commit) {
				log('The upstream baseline is from a different commit, run `bun run test:upstream`');
			}
		} else if (results.impl === 'lite') {
			log('No upstream baseline to compare against, run `bun run test:upstream`');
		}
	}
}
