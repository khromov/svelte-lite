/**
 * Build flags: opt-in techniques that can be stacked on top of any variant.
 *
 *   bun run build.ts minimal --strict-hydration --short-errors   ->  dist/minimal+strict-hydration+short-errors/
 *
 * Each flag is a Technique (see variants.ts BUILD_FLAGS). Like every other patch, the anchors
 * fail the build if upstream changes the code they match.
 */
import type { Technique } from '../variants.ts';

const RENDER = 'src/internal/client/render.js';

// ---------------------------------------------------------------------------------------------
// --strict-hydration: no client-side re-render when the SSR HTML doesn't match

/**
 * Upstream `hydrate()` recovers from a mismatch: it warns, clears the target and mounts from
 * scratch. `hydrate(..., { recover: false })` already exists as a runtime opt-out, but the
 * recovery code (`clear_text_content`, `mount()`, the "Failed to hydrate" path) still ships.
 * Here the catch block always throws `hydration_failed` for a mismatch (other errors propagate),
 * so that code tree-shakes. The `hydration_mismatch` warning at the mismatch site stays: it
 * still says where hydration went wrong.
 */
export const STRICT_HYDRATION: Technique = {
	patches: [
		{
			file: RENDER,
			feature: 'strict-hydration',
			why: 'hydrate(): a mismatch throws hydration_failed instead of clearing the target and mounting on the client (as `recover: false`, but the recovery code no longer ships)',
			replace: [
				{
					find: /\/\/ re-throw Svelte errors[\s\S]*?return mount\(component, options\);/,
					replace: '// svelte-lite --strict-hydration: no client-side recovery\n\t\tif (error === HYDRATION_ERROR) e.hydration_failed();\n\t\tthrow error;',
					count: 1,
					hash: '59cb1b2bff3a617b'
				}
			]
		}
	]
};

// ---------------------------------------------------------------------------------------------
// --short-errors: one shared helper builds the error/warning URL

const ERROR_URL = /throw new Error\(`https:\/\/svelte\.dev\/e\/([a-z_]+)`\);/g;
const WARN_URL = /console\.warn\(`https:\/\/svelte\.dev\/e\/([a-z_]+)`\);/g;

/**
 * In production every Svelte error is `throw new Error('https://svelte.dev/e/<code>')` and every
 * warning `console.warn('https://svelte.dev/e/<code>')`, one function per message (61 of them).
 * Minifiers can't share the repeated URL prefix, so each function carries it. Here each one
 * calls a shared helper with just its code, and the helper builds the same URL. Error and warning
 * text is unchanged (stack traces gain one frame). The DEV branches are untouched.
 */
export const SHORT_ERRORS: Technique = {
	patches: [
		{
			file: 'src/internal/shared/errors.js',
			feature: 'short-errors',
			why: 'define svelte_lite_error(code); production errors call it with just their code',
			replace: [
				[
					"import { DEV } from 'esm-env';",
					"import { DEV } from 'esm-env';\n\n/** svelte-lite --short-errors: the one place that builds a production error */\nexport function svelte_lite_error(code) {\n\tthrow new Error('https://svelte.dev/e/' + code);\n}",
					1
				],
				[ERROR_URL, "svelte_lite_error('$1');"]
			]
		},
		{
			file: 'src/internal/client/errors.js',
			feature: 'short-errors',
			why: 'production errors call the shared svelte_lite_error(code)',
			replace: [
				["import { DEV } from 'esm-env';", "import { DEV } from 'esm-env';\nimport { svelte_lite_error } from '../shared/errors.js';", 1],
				[ERROR_URL, "svelte_lite_error('$1');"]
			]
		},
		{
			file: 'src/internal/shared/warnings.js',
			feature: 'short-errors',
			why: 'define svelte_lite_warn(code); production warnings call it with just their code',
			replace: [
				[
					"import { DEV } from 'esm-env';",
					"import { DEV } from 'esm-env';\n\n/** svelte-lite --short-errors: the one place that builds a production warning */\nexport function svelte_lite_warn(code) {\n\tconsole.warn('https://svelte.dev/e/' + code);\n}",
					1
				],
				[WARN_URL, "svelte_lite_warn('$1');"]
			]
		},
		{
			file: 'src/internal/client/warnings.js',
			feature: 'short-errors',
			why: 'production warnings call the shared svelte_lite_warn(code)',
			replace: [
				["import { DEV } from 'esm-env';", "import { DEV } from 'esm-env';\nimport { svelte_lite_warn } from '../shared/warnings.js';", 1],
				[WARN_URL, "svelte_lite_warn('$1');"]
			]
		}
	]
};
