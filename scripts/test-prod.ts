/**
 * Runs samples of Svelte's runtime-runes suite the way an app ships them. The suite loads the
 * runtime module by module, with `DEV` on and every sample in the same instance of it, so a
 * flag that a bundler would fold is never folded there. Here each sample is compiled with
 * `dev: false`, bundled the way `bun run size` does (rollup with tree-shaking, `DEV` off) and
 * run in a jsdom window of its own, against the `html` and the `test()` of its `_config.js`.
 *
 *   bun run test:prod                  every sample that can be run this way
 *   bun run test:prod each-keyed bind  the sample of that name, or else all with it in their name
 *   bun run test:prod --minify         minified with terser as well, as an app would be (slower)
 *   bun run test:prod --jobs=2         in this many processes
 *   bun run test:prod --dev            with `DEV` left on, to tell whether a sample fails because
 *                                      it is bundled or because of what production leaves out
 *   bun run test:prod --no-cache       parsing the runtime again for every sample
 *   SVELTE_IMPL=upstream bun run test:prod   the same for Svelte itself, as a control: a sample
 *                                      that fails there as well does not fail because of svelte-lite
 *
 * A sample is run if it is in scope (its client-side test passes against Svelte according to
 * `.results/upstream.json`, and scope.json does not exclude it) and is not compiled with
 * `dev: true`. prod/skip.json lists the ones that cannot pass this way, with the reason, and
 * under `minified` the ones that cannot once they are minified. All others have to pass.
 * A sample that is named in full is run in any case.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RESULTS, ROOT, get_impl } from '../harness/paths.ts';
import { read_results } from '../harness/reporter.ts';
import { read_scope, unsupported_reason } from '../harness/scope.ts';
import { SAMPLES, SUITE, read_config } from './prod/sample.ts';
import skip from './prod/skip.json';
import type { Result, WorkerOptions } from './prod/worker.ts';

const WORKER = path.join(import.meta.dirname, 'prod/worker.ts');
const LIST = 'scripts/prod/skip.json';

/** Where the bundles of failed samples are left, to look at */
const FAILED = path.join(RESULTS, 'test-prod');

/** A sample that takes longer than this never returns: an endless loop, most likely */
const HANG = 30_000;

const args = process.argv.slice(2);
const wanted = args.filter((arg) => !arg.startsWith('--'));
const flags = new Map<string, string | undefined>();

for (const arg of args) {
	const [, flag, value] = /^--([^=]+)(?:=(.*))?$/.exec(arg) ?? [];
	if (!flag) continue;

	if (!['minify', 'dev', 'no-cache', 'jobs'].includes(flag)) {
		console.error(`Unknown option --${flag}. The top of scripts/test-prod.ts has the ones there are`);
		process.exit(2);
	}

	flags.set(flag, value);
}

const options: WorkerOptions = {
	minify: flags.has('minify'),
	dev: flags.has('dev'),
	cache: !flags.has('no-cache'),
	failed: FAILED
};

const baseline = read_results('upstream');

if (!baseline) {
	console.error('No upstream baseline, which says what is in scope. Run `bun run test:upstream`');
	process.exit(2);
}

const impl = get_impl();
const scope = impl === 'lite' ? read_scope() : null;

/** Samples not to run, by name, with the key of the reason. Some only fail when minified */
const listed: Record<string, string> = { ...skip.samples, ...(options.minify ? skip.minified : {}) };

for (const [name, key] of Object.entries({ ...skip.samples, ...skip.minified })) {
	if (!(key in skip.reasons)) {
		console.error(`${LIST} gives "${key}" as the reason for ${name}, which is not one of its reasons`);
		process.exit(2);
	}
}

/** Why a sample is not run, or `null` if it is */
function exclusion(name: string): { why: 'no-test' | 'scope' | 'dev' | 'listed'; text: string } | null {
	const test = `${name} (dom)`;

	if (baseline!.tests[`${SUITE} > ${test}`] !== 'passed') {
		return { why: 'no-test', text: 'has no client-side test that passes against Svelte' };
	}

	const reason = scope && unsupported_reason(scope, SUITE, test);
	if (reason) return { why: 'scope', text: `out of scope: ${reason}` };

	try {
		if (read_config(name).compile_options.dev) return { why: 'dev', text: 'compiled with `dev: true`' };
	} catch {
		// the worker comes across this again, and reports it
	}

	if (name in listed) return { why: 'listed', text: `listed in ${LIST}: ${listed[name]}` };

	return null;
}

const samples = new Map(
	fs
		.readdirSync(SAMPLES)
		.filter((name) => name[0] !== '.')
		.sort()
		.map((name) => [name, exclusion(name)])
);

const count = (why: string) => [...samples.values()].filter((excluded) => excluded?.why === why).length;
const runnable = [...samples.keys()].filter((name) => !samples.get(name));

/** A sample by its name, or else the ones that are run and have this in their name */
const matching = (arg: string) => (samples.has(arg) ? [arg] : runnable.filter((name) => name.includes(arg)));
const selected = wanted.length === 0 ? runnable : [...new Set(wanted.flatMap(matching))];

if (selected.length === 0) {
	console.error(`No sample that would be run has ${wanted.join(' or ')} in its name`);
	process.exit(2);
}

const jobs = Math.min(
	selected.length,
	Number(flags.get('jobs')) || Math.max(1, Math.min(4, os.availableParallelism() >> 1))
);

console.log(
	`${SUITE} as production bundles of ${impl === 'lite' ? 'svelte-lite' : 'Svelte'} ` +
		`(rollup${options.dev ? ', `DEV` on' : ''}${options.minify ? ', terser' : ''}): ` +
		`${selected.length} ${selected.length === 1 ? 'sample' : 'samples'} ` +
		`in ${jobs} ${jobs === 1 ? 'process' : 'processes'}\n`
);

const started = performance.now();
const results = await run(selected);
const seconds = ((performance.now() - started) / 1000).toFixed(1);

const failed = results.filter((result) => result.state === 'failed');
const passed = results.length - failed.length;

for (const result of failed) {
	const excluded = samples.get(result.name);

	console.log(` ✗ ${result.name}${excluded ? `  (${excluded.text})` : ''}`);
	// with only a few samples asked for, there is room for the whole error
	console.log((wanted.length > 0 ? `${result.details}\n` : result.error!).replace(/^/gm, '     '));
}

if (failed.length > 0 && wanted.length === 0) console.log();

if (wanted.length === 0) {
	const total = runnable.length + count('dev') + count('listed');
	const column = (n: number) => String(n).padStart(String(total).length);

	console.log(`${column(total)} samples ${scope ? 'in scope' : 'with a client-side test'}`);
	console.log(`${column(count('dev'))} not run: compiled with \`dev: true\``);
	console.log(`${column(count('listed'))} not run: listed in ${LIST}`);

	for (const [key, text] of Object.entries(skip.reasons)) {
		const n = Object.keys(listed).filter(
			(name) => listed[name] === key && samples.get(name)?.why === 'listed'
		).length;

		if (n > 0) console.log(`${' '.repeat(column(0).length + 3)}${column(n)} ${text}`);
	}

	console.log(`${column(results.length)} run: ${passed} passed, ${failed.length} failed`);

	// Entries that have had their day: the sample is gone, or would not be run anyway. One
	// that is out of scope stays, for when Svelte is the one that is bundled
	const stale = Object.keys({ ...skip.samples, ...skip.minified }).filter(
		(name) => !samples.has(name) || ['no-test', 'dev'].includes(samples.get(name)?.why as string)
	);

	if (stale.length > 0) {
		console.log(`\nListed in ${LIST}, but not a sample that would be run otherwise: ${stale.join(', ')}`);
	}
} else {
	console.log(`${passed} of ${results.length} passed`);
}

if (failed.length > 0) {
	console.log(`The bundles of the failed samples are in ${path.relative(ROOT, FAILED)}/`);
}

console.log(`${seconds}s`);

// a sample that was only run because it was named does not have to pass
process.exit(failed.some((result) => !samples.get(result.name)) ? 1 : 0);

/** Has worker processes run the samples, each taking the next one when it is done with the last */
function run(names: string[]) {
	const queue = [...names];
	const results: Result[] = [];

	fs.rmSync(FAILED, { recursive: true, force: true });

	return new Promise<Result[]>((resolve) => {
		const done = (result: Result) => {
			results.push(result);

			if (process.stdout.isTTY) {
				process.stdout.write(`\r${results.length}/${names.length}${results.length === names.length ? '\r' : ''}`);
			}

			if (results.length === names.length) {
				resolve(results.sort((a, b) => a.name.localeCompare(b.name)));
			}
		};

		const start = () => {
			let ready = false;
			let hung = false;
			let current: string | undefined;
			let watchdog: ReturnType<typeof setTimeout> | undefined;

			const next = () => {
				clearTimeout(watchdog);
				current = queue.shift();

				if (current === undefined) {
					worker.kill();
					return;
				}

				worker.send(current);

				watchdog = setTimeout(() => {
					hung = true;
					worker.kill('SIGKILL');
				}, HANG);
			};

			const worker = Bun.spawn([process.execPath, WORKER, JSON.stringify(options)], {
				stdio: ['ignore', 'inherit', 'inherit'],

				ipc(message: 'ready' | Result) {
					if (message === 'ready') {
						ready = true;
					} else {
						done(message);
					}

					next();
				},

				onExit(_, code, signal) {
					clearTimeout(watchdog);

					if (!ready) {
						console.error(`A worker did not start (${signal ?? `exit code ${code}`})`);
						process.exit(2);
					}

					// it was in the middle of a sample: another worker goes on from there
					if (current !== undefined) {
						const error = hung
							? `No result after ${HANG / 1000}s: the sample does not return`
							: `The worker stopped while it ran the sample (${signal ?? `exit code ${code}`})`;

						done({ name: current, state: 'failed', error, details: error });
						start();
					}
				}
			});
		};

		for (let i = 0; i < jobs; i += 1) start();
	});
}
