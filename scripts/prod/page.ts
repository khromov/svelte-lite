/**
 * Runs in the jsdom window, before and around the bundle of a sample. It does what
 * `run_test_variant` in Svelte's `tests/runtime-legacy/shared.ts` does for the `dom` variant
 * of a runes sample, with the bundle in the place of the modules that vitest loads.
 *
 * Bundled by itself (see `build_page` in sample.ts), so that nothing of it ends up in the
 * bundle under test, and evaluated first, so that it sees what the sample does while it loads.
 */
import { assert } from 'chai';
import {
	assert_html_equal,
	assert_html_equal_with_options
} from '../../vendor/svelte/packages/svelte/tests/html_equal.js';
import { ok } from './stand-ins.ts';

/** What the runner knows before the bundle runs, from reading `_config.js` */
export interface Options {
	/** What the components were compiled with */
	compile_options: Record<string, unknown>;
	/** The CSS of the components */
	styles: string;
	/** Whether the sample expects errors: calls of `console.error`, and errors that nothing catches */
	intercept_errors: boolean;
}

/**
 * What a bundle puts on `window`, see `start` and `entry` in sample.ts. If its components
 * fail to load, there is no more than the config
 */
export interface Sample {
	config: Record<string, any>;
	component: unknown;
	mount: (component: any, options: Record<string, unknown>) => Record<string, any>;
	unmount: (instance: any) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	/** Missing if the sample has no props and its test does not set any */
	proxy?: <T>(value: T) => T;
	/** `raf` of `tests/animation-helpers.js`. Missing if nothing in the bundle uses the clock */
	raf?: { tick: (ms: number) => void };
}

declare global {
	interface Window {
		__options: Options;
		__sample?: Sample;
		__page: { run: typeof run; reject: typeof reject };
	}
}

const { compile_options, styles, intercept_errors } = window.__options;

const logs: unknown[] = [];
const warnings: unknown[] = [];
const errors: unknown[] = [];

/** An error that nothing caught, in an event handler or a timer, or a promise that was rejected */
let unhandled: unknown = null;

console.log = (...args) => {
	logs.push(...args);
};

console.warn = (...args) => {
	if (typeof args[0] === 'string' && args[0].startsWith('%c[svelte]')) {
		let message = args[0];
		message = message.slice(message.indexOf('%c', 2) + 2);

		// Remove the "https://svelte.dev/e/..." link at the end
		const lines = message.split('\n');
		if (lines.at(-1)?.startsWith('https://svelte.dev/e/')) {
			lines.pop();
		}

		warnings.push(lines.join('\n'));
	} else {
		warnings.push(...args);
	}
};

console.error = (...args) => {
	errors.push(...args);
};

// Capture phase so we still see the error if a test installs its own
// `stopImmediatePropagation` listener
window.addEventListener(
	'error',
	(e) => {
		if (intercept_errors) {
			const detail = e.error;
			const is_error = detail && detail.name && detail.message !== undefined && detail.stack;
			const error_string = is_error ? `[${detail.name}: ${detail.message}]` : String(detail);
			errors.push(`Error: Uncaught ${error_string}\n${detail?.stack ?? ''}`, detail);
		} else {
			unhandled = e.error;
		}

		e.preventDefault();
	},
	true
);

window.requestAnimationFrame = window.setTimeout as typeof window.requestAnimationFrame;

// jsdom does not have it. In the suite, `tests/helpers.js` adds this
window.matchMedia = (media) =>
	({
		matches: false,
		media,
		addEventListener: () => {},
		removeEventListener: () => {}
	}) as unknown as MediaQueryList;

document.head.innerHTML = styles ? `<style>${styles}</style>` : '';

/** A promise was rejected and nothing handled it. Only the process hears of that */
function reject(error: unknown) {
	unhandled = error;
}

/**
 * Mounts the component of the sample, compares, runs its test and unmounts. Throws if the
 * sample fails. `load_error` is what evaluating the bundle threw, if it did
 */
async function run(load_error?: { error: unknown }) {
	const sample = window.__sample;

	// not even the config has loaded, which might have expected this
	if (!sample) throw load_error!.error;

	const { config, flushSync } = sample;
	const target = document.querySelector('main')!;

	let unintended_error = false;

	try {
		if (load_error) throw load_error.error;

		logs.length = warnings.length = 0;

		config.before_test?.();

		const props = { ...(config.props || {}) };
		const component = sample.proxy ? sample.proxy(props) : props;

		const instance = sample.mount(sample.component, {
			target,
			props: component,
			intro: config.intro,
			recover: config.recover ?? false,
			transformError: config.transformError
		});

		if (config.error) {
			unintended_error = true;
			assert.fail('Expected a runtime error');
		}

		if (config.html) {
			flushSync();
			assert_html_equal_with_options(target.innerHTML, config.html, {
				preserveComments: config.withoutNormalizeHtml === 'only-strip-comments' ? false : undefined,
				withoutNormalizeHtml: !!config.withoutNormalizeHtml
			});
		}

		try {
			if (config.test) {
				if (!config.skip_initial_flushSync) flushSync();

				await config.test({
					assert: {
						...assert,
						htmlEqual: assert_html_equal,
						htmlEqualWithOptions: assert_html_equal_with_options
					},
					variant: 'dom',
					component,
					instance,
					mod: { default: sample.component },
					ok,
					target,
					snapshot: undefined,
					window,
					raf: sample.raf,
					compileOptions: compile_options,
					logs,
					warnings,
					errors,
					hydrate: () => {
						throw new Error('Ensure dom mode is skipped');
					}
				});

				flushSync();
			}

			if (config.runtime_error && !unhandled) {
				unintended_error = true;
				assert.fail('Expected a runtime error');
			}
		} finally {
			await sample.unmount(instance);

			if (config.warnings) {
				assert.deepEqual(warnings, config.warnings);
			}

			if (config.errors) {
				assert.deepEqual(errors, config.errors);
			}

			assert_html_equal(
				target.innerHTML,
				'',
				'Expected component to unmount and leave nothing behind after it was destroyed'
			);

			// uncaught errors like during template effects flush
			if (unhandled) {
				if (!config.expect_unhandled_rejections) {
					throw unhandled; // eslint-disable-line no-unsafe-finally
				}
			}
		}
	} catch (err) {
		if (config.runtime_error) {
			assert.include((err as Error).message, config.runtime_error);
		} else if (config.error && !unintended_error) {
			assert.include((err as Error).message, config.error);
		} else {
			throw err;
		}
	} finally {
		config.after_test?.();
	}
}

window.__page = { run, reject };
