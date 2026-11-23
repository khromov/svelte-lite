import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Reporter, SerializedError, TestModule, Vitest } from 'vitest/node';
import { RESULTS, ROOT, UPSTREAM_PKG, UPSTREAM_ROOT, type Impl } from './paths.ts';
import { read_package } from './resolve.ts';
import { area_of, read_scope, split_key, unsupported_reason, type Area, type Scope } from './scope.ts';

type State = 'passed' | 'failed' | 'skipped';

interface Suite {
	passed: number;
	/** Tests that should pass and do not */
	failed: number;
	/** Tests that fail and are out of scope, see scope.json */
	unsupported: number;
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
	/** The tests that are in scope and do not pass, including ones that never ran, with the error */
	failing: Record<string, string>;
}

/** Async mode is not what svelte-lite is measured against, so it is kept apart */
const mode = process.env.SVELTE_NO_ASYNC === 'false' ? '-async' : '';

export function results_file(impl: Impl) {
	return path.join(RESULTS, `${impl}${mode}.json`);
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
 *
 * For svelte-lite, a failing test only counts if it is in scope (see scope.json),
 * and a test that upstream passes but that never ran counts as failing.
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
			tests: {},
			failing: {}
		};

		const scope: Scope | null = this.impl === 'lite' ? read_scope() : null;
		const suite = (name: string) =>
			(results.suites[name] ??= { passed: 0, failed: 0, unsupported: 0, skipped: 0, errors: [] });

		/** The first error of each test that is in scope and fails */
		const failures = new Map<string, string>();

		/** Tests that are listed as out of scope and pass anyway */
		const surprises: string[] = [];

		// shards of a suite finish in any order, the record should not depend on it
		const ordered = [...modules].sort(
			(a, b) => a.moduleId.localeCompare(b.moduleId) || a.project.name.localeCompare(b.project.name)
		);

		for (const module of ordered) {
			const name = suite_name(module.moduleId);

			// errors of the module itself, and of `describe` blocks whose hooks failed
			for (const group of [module, ...module.children.allSuites()]) {
				suite(name).errors.push(...group.errors().map(headline));
			}

			for (const test of module.children.allTests()) {
				const result = test.result();
				const state: State = result.state === 'pending' ? 'skipped' : result.state;
				const reason = scope && unsupported_reason(scope, name, test.fullName);

				// a few tests share a name with another one in the same file
				let key = `${name} > ${test.fullName}`;
				for (let n = 2; key in results.tests; n += 1) key = `${name} > ${test.fullName} (${n})`;

				results.tests[key] = state;

				if (result.state === 'failed' && reason) {
					suite(name).unsupported += 1;
				} else {
					suite(name)[state] += 1;
				}

				if (result.state === 'failed' && !reason) {
					failures.set(key, result.errors[0] ? headline(result.errors[0]) : '(no error)');
				}

				if (result.state === 'passed' && reason) surprises.push(key);
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

		// a test file that fails to load registers no tests, which would otherwise
		// look the same as having nothing to fail
		if (scope && baseline && !filtered) {
			for (const [key, state] of Object.entries(baseline.tests)) {
				if (state !== 'passed' || key in results.tests) continue;

				const [name, test] = split_key(key);
				if (unsupported_reason(scope, name, test)) continue;

				suite(name).failed += 1;
				failures.set(key, 'did not run: its test file failed to load, or the test is gone');
			}
		}

		results.failing = Object.fromEntries([...failures].sort(([a], [b]) => a.localeCompare(b)));

		this.print(results, failures, surprises, unhandled.length, filtered, !!baseline);

		// what scripts/test.ts decides the exit code on
		fs.mkdirSync(RESULTS, { recursive: true });
		fs.writeFileSync(
			path.join(RESULTS, 'last-run.json'),
			JSON.stringify({ failing: failures.size, unhandled: unhandled.length })
		);

		if (!filtered) {
			fs.writeFileSync(results_file(this.impl), JSON.stringify(results, null, '\t'));

			if (this.impl === 'lite') {
				fs.writeFileSync(
					path.join(RESULTS, 'lite-failing.txt'),
					[...failures].map(([key, error]) => `${key}\n    ${error}\n`).join('')
				);
			}
		}
	}

	private print(
		results: Results,
		failures: Map<string, string>,
		surprises: string[],
		unhandled: number,
		filtered: boolean,
		has_baseline: boolean
	) {
		const log = (line = '') => this.vitest.logger.log(line);
		const lite = results.impl === 'lite';
		const names = Object.keys(results.suites).sort();
		const columns = lite
			? (['passed', 'failed', 'unsupported', 'skipped'] as const)
			: (['passed', 'failed', 'skipped'] as const);

		const total: Record<string, number> = { passed: 0, failed: 0, unsupported: 0, skipped: 0, errors: 0 };

		const rows = names.map((name) => {
			const suite = results.suites[name];

			for (const column of columns) total[column] += suite[column];
			total.errors += suite.errors.length;

			return [
				name,
				...columns.map((column) => format(suite[column])),
				suite.errors.length ? format(suite.errors.length) : ''
			];
		});

		rows.unshift(['suite', ...columns, 'errors']);
		rows.push([
			'total',
			...columns.map((column) => format(total[column])),
			total.errors ? format(total.errors) : ''
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

		const broken = names.filter((name) => results.suites[name].errors.length > 0);

		if (broken.length > 0) {
			log('Errors outside of tests (a file that fails to load registers no tests):');

			for (const name of broken) {
				const errors = [...new Set(results.suites[name].errors)];
				for (const error of errors.slice(0, 3)) log(`  ${name}: ${error}`);
				if (errors.length > 3) log(`  ${name}: … and ${errors.length - 3} more`);
			}

			log();
		}

		if (failures.size > 0) {
			const messages = new Map<string, number>();
			for (const error of failures.values()) messages.set(error, (messages.get(error) ?? 0) + 1);

			const sorted = [...messages].sort((a, b) => b[1] - a[1]);
			const width = format(sorted[0][1]).length;

			log('Most common failures:');
			for (const [message, count] of sorted.slice(0, 12)) {
				log(`  ${format(count).padStart(width)}× ${message}`);
			}
			if (sorted.length > 12) log(`  … and ${format(sorted.length - 12)} other distinct messages`);
			log();
		}

		if (lite) {
			// only the client runtime is svelte-lite's own, the rest is Svelte's code
			const areas: Record<Area, { passed: number; failed: number }> = {
				client: { passed: 0, failed: 0 },
				compiler: { passed: 0, failed: 0 },
				server: { passed: 0, failed: 0 }
			};

			for (const [key, state] of Object.entries(results.tests)) {
				if (state === 'passed') areas[area_of(...split_key(key))].passed += 1;
			}

			for (const key of failures.keys()) areas[area_of(...split_key(key))].failed += 1;

			const row = (label: string, { passed, failed }: { passed: number; failed: number }) =>
				`${label.padEnd(30)} ${format(passed).padStart(6)} of ${format(passed + failed).padStart(6)} pass`;

			log('Tests in scope:');
			log(`  ${row('client runtime', areas.client)}`);
			log(`  ${row('compiler (reused from Svelte)', areas.compiler)}`);
			log(`  ${row('server (reused from Svelte)', areas.server)}`);

			if (surprises.length > 0) {
				log(`  ${format(surprises.length)} tests pass although scope.json lists them as unsupported`);
			}
		} else {
			const ran = total.passed + total.failed;
			log(`${format(total.passed)} of ${format(ran)} tests passed (${percent(total.passed, ran)})`);
		}

		if (unhandled > 0) log(`${format(unhandled)} unhandled errors`);

		if (filtered) {
			log('Filtered run, results not recorded');
		} else if (lite && !has_baseline) {
			log('No upstream baseline, so tests that never ran go unnoticed. Run `bun run test:upstream`');
		} else if (lite && failures.size > 0) {
			log(`The failing tests are listed in ${path.relative(ROOT, RESULTS)}/lite-failing.txt`);
		}
	}
}
