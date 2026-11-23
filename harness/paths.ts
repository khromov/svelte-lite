import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The pinned checkout of sveltejs/svelte (a git submodule, never edited) */
export const UPSTREAM_ROOT = path.join(ROOT, 'vendor/svelte');
export const UPSTREAM_PKG = path.join(UPSTREAM_ROOT, 'packages/svelte');
export const UPSTREAM_SRC = path.join(UPSTREAM_PKG, 'src');
export const UPSTREAM_TESTS = path.join(UPSTREAM_PKG, 'tests');

/** Mirrors the upstream `src/` paths that upstream tests import, see compat/README.md */
export const COMPAT = path.join(ROOT, 'compat');

export const RESULTS = path.join(ROOT, '.results');

/**
 * Which implementation the upstream suite runs against:
 * - `lite`: svelte-lite (this repo)
 * - `upstream`: the real Svelte in the submodule, as a control for the harness itself
 */
export type Impl = 'lite' | 'upstream';

export function get_impl(env: Record<string, string | undefined> = process.env): Impl {
	const value = env.SVELTE_IMPL ?? 'lite';

	if (value !== 'lite' && value !== 'upstream') {
		throw new Error(`SVELTE_IMPL must be "lite" or "upstream", got "${value}"`);
	}

	return value;
}

export function is_inside(file: string, dir: string) {
	return file === dir || file.startsWith(dir + path.sep);
}
