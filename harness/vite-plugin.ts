import path from 'node:path';
import type { Plugin } from 'vite';
import { ROOT, UPSTREAM_TESTS, is_inside, type Impl } from './paths.ts';
import { clean_id, create_resolver } from './resolve.ts';

const esbuild_wrapper = path.join(ROOT, 'harness/esbuild.ts');

/**
 * Points the upstream suite at the implementation under test. This takes the place
 * of the `svelte` alias in upstream's `vitest.config.js`.
 */
export function svelte_impl(impl: Impl, options: { force_server?: boolean } = {}): Plugin {
	const { resolve, check_load } = create_resolver(impl, options);

	return {
		name: 'svelte-lite:impl',
		enforce: 'pre',

		resolveId(id, importer) {
			// the browser suite bundles with esbuild, which resolves imports on its own
			if (impl === 'lite' && id === 'esbuild' && importer) {
				if (is_inside(clean_id(importer), UPSTREAM_TESTS)) return esbuild_wrapper;
			}

			return resolve(id, importer);
		},

		load(id) {
			check_load(id);
			return null;
		}
	};
}
