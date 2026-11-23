/**
 * A process that builds and runs the samples it is told to, one at a time. scripts/test-prod.ts
 * starts a few of these, and can stop one from outside if a sample never returns.
 *
 * Every sample gets a jsdom window of its own, with its bundle as all there is of the runtime.
 * Bundle and test run inside that window, as they would in a browser, and not in this process
 * with the window's globals copied over, which is how vitest does it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';
import { ROOT } from '../../harness/paths.ts';
import type { Options } from './page.ts';
import { build_page, read_config, sample_builder, type BuildOptions, type Config } from './sample.ts';

export interface WorkerOptions extends BuildOptions {
	/** Where to leave the bundles of failed samples, to look at */
	failed: string;
}

export interface Result {
	name: string;
	state: 'passed' | 'failed';
	/** The first line of the error */
	error?: string;
	/** All of it */
	details?: string;
}

/** How long a test may wait for something */
const TIMEOUT = 10_000;

const options: WorkerOptions = JSON.parse(process.argv[2]);

const build = sample_builder(options);
const page = new Script(await build_page());

/** Takes errors that reach the process, which come from the sample that is running */
let report: (error: unknown) => void = console.error;

process.on('unhandledRejection', (error) => report(error));
process.on('uncaughtException', (error) => report(error));

async function execute(config: Config, { code, styles }: { code: string; styles: string }) {
	// as vitest sets up jsdom for the suite
	const dom = new JSDOM('<!DOCTYPE html><main></main>', {
		url: 'http://localhost:3000',
		pretendToBeVisual: true,
		runScripts: 'dangerously',
		// what a sample prints goes nowhere, unless its test asks for it
		virtualConsole: new VirtualConsole()
	});

	const { window } = dom;

	const page_options: Options = {
		compile_options: config.compile_options,
		styles,
		intercept_errors: config.asks_for('errors') || config.has('errors')
	};

	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		window.structuredClone = <T>(value: T) => adopt(window, structuredClone(value));

		// (parsed in the window, so that tests are handed objects of their own realm)
		window.__options = window.JSON.parse(JSON.stringify(page_options));
		page.runInContext(dom.getInternalVMContext());

		report = window.__page.reject;

		let load_error: { error: unknown } | undefined;

		try {
			window.eval(code);
		} catch (error) {
			load_error = { error };
		}

		// The suite imports the components and awaits that. What they set off while loading
		// has happened by the time it mounts
		await new Promise((resolve) => setImmediate(resolve));

		await Promise.race([
			window.__page.run(load_error),
			new Promise((_, reject) => {
				const expired = () => reject(new Error(`The test did not finish in ${TIMEOUT / 1000}s`));
				timer = setTimeout(expired, TIMEOUT);
			})
		]);
	} finally {
		clearTimeout(timer);

		// A promise that was rejected at the very end is reported to the process about now.
		// The suite lets that pass, but it is not for the next sample to hear of
		await new Promise((resolve) => setImmediate(resolve));

		report = console.error;
		window.close();
	}
}

const BUILT_INS = [
	...['Object', 'Array', 'Date', 'RegExp', 'Map', 'Set', 'Boolean', 'Number', 'String', 'BigInt'],
	...['Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError'],
	...['ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array'],
	...['Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array'],
	...['BigInt64Array', 'BigUint64Array']
] as const;

/**
 * jsdom has no `structuredClone`, which every browser has. The one of this process makes
 * objects of this process, which are no `Date` or `Map` to code in the window: this makes
 * them the window's own.
 */
function adopt<T>(window: Window & typeof globalThis, value: T, seen = new Set<unknown>()): T {
	if (typeof value !== 'object' || value === null || seen.has(value)) return value;
	seen.add(value);

	const children =
		value instanceof Map
			? [...value.keys(), ...value.values()]
			: value instanceof Set
				? [...value]
				: Object.values(value);

	for (const name of BUILT_INS) {
		if (Object.getPrototypeOf(value) === globalThis[name].prototype) {
			Object.setPrototypeOf(value, window[name].prototype);
		}
	}

	for (const child of children) adopt(window, child, seen);

	return value;
}

/** Anything can be thrown, and an error of the window is not an `Error` here */
function describe(error: any): Pick<Result, 'error' | 'details'> {
	const message = String(error?.message ?? error).replaceAll(ROOT, '.');
	const first = message.split('\n')[0];

	let details = typeof error?.stack === 'string' ? error.stack.replaceAll(ROOT, '.') : message;
	if (!details.includes(message)) details = `${message}\n${details}`;

	// what an assertion compared, which its message abbreviates
	if (typeof error === 'object' && error && 'actual' in error && 'expected' in error) {
		const show = (value: unknown) => {
			try {
				return typeof value === 'string' ? value : JSON.stringify(value, null, '  ');
			} catch {
				return String(value);
			}
		};

		details += `\n\nactual:\n${show(error.actual)}\n\nexpected:\n${show(error.expected)}`;
	}

	return { error: first.length > 140 ? `${first.slice(0, 139)}…` : first, details };
}

async function run(name: string): Promise<Result> {
	let built: Awaited<ReturnType<typeof build>> | undefined;

	try {
		const config = read_config(name);

		built = await build(name, config);
		await execute(config, built);

		return { name, state: 'passed' };
	} catch (error) {
		if (built) {
			fs.mkdirSync(options.failed, { recursive: true });
			fs.writeFileSync(path.join(options.failed, `${name}.js`), built.code);
		}

		return { name, state: 'failed', ...describe(error) };
	}
}

process.on('message', async (name: string) => {
	process.send!(await run(name));
});

// not to be left behind when the run is interrupted
process.on('disconnect', () => process.exit());

process.send!('ready');
