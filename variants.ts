/**
 * Build variants. `bun run build.ts <name>` builds one into dist/<name>/<app>/.
 *
 * Every variant is "the official, linked Svelte source + a patch list applied at build
 * time" (never a fork: the vendored checkout is not modified). PATCHES.md documents every patch;
 * `bun scripts/patches-doc.ts` regenerates it from these definitions.
 *
 *   baseline   vanilla Svelte, standard Bun.build options
 *   optimized  lossless build fixes only (no feature loss for any app)
 *   minimal    optimized + the feature drops chosen for svelte-lite:
 *              legacy mode, async, transitions/animations, root boundary, eager
 *              delegation, and the always-bundled $state proxy
 *   m1..m5     stacking steps between optimized and minimal (for COMPARISON.md)
 */
import type { BunPlugin } from 'bun';
import type { CompileOptions } from 'svelte/compiler';
import type { ConstImport, SourcePatch } from './plugins/patch.ts';
import type { SveltePluginOptions } from './plugins/svelte.ts';
import {
	ASYNC,
	DELEGATION,
	LEGACY,
	PROXY,
	ROOT_BOUNDARY,
	TRANSITIONS
} from './patches/minimal.ts';
import { DISCLOSE, DEV_CONST, NAMED_IMPORTS, PURE } from './patches/optimized.ts';
import { SHORT_ERRORS, STRICT_HYDRATION } from './patches/flags.ts';

export interface Variant {
	description: string;
	define?: Record<string, string>;
	features?: string[];
	drop?: string[];
	compilerOptions?: Partial<CompileOptions>;
	/** Options for plugins/svelte.ts (namedImports, proxySet, forbid). */
	svelte?: Omit<SveltePluginOptions, 'compilerOptions' | 'generate'>;
	/** Bun `optimizeImports`: packages whose barrel files may skip unused re-exports. */
	optimizeImports?: string[];
	constImports?: ConstImport[];
	patches?: SourcePatch[];
	plugins?: BunPlugin[];
	/** Run the post-pass (postpass.ts): dead private members + provably dead statements. */
	postpass?: boolean;
}

/** A named slice of a variant (patches + options) that serves one feature. */
export type Technique = Partial<Variant>;

/** Merge techniques: arrays concatenated, objects merged one level deep. */
export function stack(description: string, ...parts: Technique[]): Variant {
	const out: any = { description };
	for (const p of parts) {
		for (const [k, v] of Object.entries(p)) {
			const cur = out[k];
			if (Array.isArray(v)) out[k] = [...(cur ?? []), ...v];
			else if (v && typeof v === 'object') {
				const merged: any = { ...(cur ?? {}) };
				for (const [kk, vv] of Object.entries(v)) merged[kk] = Array.isArray(vv) ? [...(merged[kk] ?? []), ...vv] : vv;
				out[k] = merged;
			} else out[k] = v;
		}
	}
	return out;
}

const OPTIMIZED: Technique[] = [DEV_CONST, NAMED_IMPORTS, PURE, DISCLOSE, { postpass: true }];
const STEPS: Array<[string, string, Technique]> = [
	['m1-legacy', '+ drop legacy mode', LEGACY],
	['m2-async', '+ drop async', ASYNC],
	['m3-transitions', '+ drop transitions/animations', TRANSITIONS],
	['m4-boundary', '+ skip root boundary', ROOT_BOUNDARY],
	['m5-delegation', '+ lazy event delegation', DELEGATION],
	['minimal', '+ tree-shakable $state proxy', PROXY]
];

export const variants: Record<string, Variant> = {
	baseline: {
		description: 'Vanilla Svelte runtime + stock compiler options; only standard Bun.build DCE options.'
	},
	optimized: stack('Lossless build fixes: DEV const, barrel imports, PURE, no disclose-version, dead-code post-pass', ...OPTIMIZED)
};

for (let i = 0; i < STEPS.length; i++) {
	const [name, what] = STEPS[i];
	variants[name] = stack(
		name === 'minimal' ? 'optimized + all svelte-lite feature drops' : `optimized ${STEPS.slice(0, i + 1).map((s) => s[1]).join(' ')}`,
		...OPTIMIZED,
		...STEPS.slice(0, i + 1).map((s) => s[2])
	);
	void what;
}

/**
 * Build flags: opt-in techniques stacked on top of any variant
 * (`bun run build.ts minimal --strict-hydration --short-errors`). A flagged build is its own
 * variant named `<variant>+<flag>…` (flags in this order), built into dist/<that name>/.
 */
export const BUILD_FLAGS: Record<string, Technique> = {
	'strict-hydration': STRICT_HYDRATION,
	'short-errors': SHORT_ERRORS
};

/** Resolve a variant name, including flagged names like `minimal+strict-hydration`. */
export function resolveVariant(name: string): Variant | undefined {
	const [base, ...flags] = name.split('+');
	const variant = variants[base];
	if (!variant || flags.some((f) => !BUILD_FLAGS[f])) return undefined;
	if (!flags.length) return variant;
	return {
		...stack('', variant as Technique, ...flags.map((f) => BUILD_FLAGS[f])),
		description: `${variant.description} + ${flags.map((f) => `--${f}`).join(' ')}`
	};
}

/** `<variant>+<flag>…` with the flags in canonical (BUILD_FLAGS) order. */
export const flaggedName = (base: string, flags: string[]) =>
	[base, ...Object.keys(BUILD_FLAGS).filter((f) => flags.includes(f))].join('+');

/** Variant names in stacking order (for COMPARISON.md). */
export const STACK_ORDER = [
	'baseline',
	'optimized',
	...STEPS.map((s) => s[0]),
	// build flags, one at a time on top of minimal
	'minimal+strict-hydration',
	'minimal+strict-hydration+short-errors'
];
