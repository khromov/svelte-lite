/**
 * `optimized`: lossless build fixes. None of these changes behaviour for any app; they
 * only let Bun remove code it otherwise can't prove dead. See PATCHES.md.
 */
import type { Technique } from '../variants.ts';

/**
 * esm-env's DEV/BROWSER/NODE as foldable module-local constants. Bun 1.4.2 does not
 * propagate `export default false` (esm-env/false.js) across modules, so without this
 * every `if (DEV)` in the runtime ships. Values are exactly what the `production` +
 * `browser` export conditions already resolve to, so behaviour is unchanged.
 */
export const DEV_CONST: Technique = {
	constImports: [
		{
			from: 'esm-env',
			values: { DEV: 'false', BROWSER: 'true', NODE: 'false' },
			feature: 'dev',
			why: 'esm-env value (as resolved by the production/browser conditions) as a foldable local const'
		}
	],
	patches: [
		{
			file: 'src/internal/client/proxy.js',
			feature: 'dev',
			why: 'dev-only nested update_path() (its only use is `if (DEV && ...) return update_path`); Bun never removes unused nested functions, and it keeps tag()/get_label() alive',
			removeFunctions: ['update_path']
		}
	]
};

/**
 * Compiled components import runtime functions by name instead of `import * as $`, and
 * Bun's barrel optimisation skips runtime modules nobody imports. Drops custom-element.js,
 * whose top-level `if (typeof HTMLElement === 'function') SvelteElement = class ...` side
 * effect otherwise keeps legacy-client.js, flushSync() etc. No runtime source is patched.
 */
export const NAMED_IMPORTS: Technique = {
	svelte: { namedImports: true },
	optimizeImports: ['svelte']
};

/**
 * Let unused top-level constants go: `Symbol('x')`, array spreads and a
 * `globalThis.document` read are not provably pure to Bun, so unused ones are kept.
 */
export const PURE: Technique = {
	patches: [
		{
			file: /^src\/.*\.js$/,
			feature: 'pure',
			why: 'mark top-level `Symbol(...)` initialisers /*@__PURE__*/ so unused ones tree-shake',
			optional: true,
			replace: [[/(\b(?:const|let) \w+ = )Symbol\(/g, '$1/* @__PURE__ */ Symbol(']]
		},
		{
			file: 'src/utils.js',
			feature: 'pure',
			why: 'wrap spread arrays (DOM_PROPERTIES, RUNES) in pure IIFEs so they tree-shake when unused',
			replace: [
				[/(const DOM_PROPERTIES = )(\[[\s\S]*?\n\]);/, '$1/* @__PURE__ */ (() => $2)();', 1],
				[/(export const RUNES = )\/\*\* @type \{const\} \*\/ \((\[[\s\S]*?\n\])\);/, '$1/* @__PURE__ */ (() => $2)();', 1]
			]
		},
		{
			file: 'src/internal/shared/attributes.js',
			feature: 'pure',
			why: 'wrap the `whitespace` string spread in a pure IIFE',
			replace: [[/const whitespace = (\[\.\.\.[^\]]*\]);/, 'const whitespace = /* @__PURE__ */ (() => $1)();', 1]]
		},
		{
			file: 'src/internal/client/constants.js',
			feature: 'pure',
			why: 'IS_XHTML reads globalThis.document at module init; wrap in a pure IIFE',
			replace: [
				[
					/export const IS_XHTML =[\s\S]*?includes\('xml'\);/,
					"export const IS_XHTML = /* @__PURE__ */ (() => !!globalThis.document?.contentType && globalThis.document.contentType.includes('xml'))();",
					1
				]
			]
		}
	]
};

/** No `window.__svelte.v` version registration (compiler option; nothing functional). */
export const DISCLOSE: Technique = { compilerOptions: { discloseVersion: false } };
