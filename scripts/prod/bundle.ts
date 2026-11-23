/**
 * What a production build does with an app: rollup with tree-shaking, `esm-env` resolved for
 * the browser with `DEV` off, then terser. `bun run size` measures the result, and
 * `bun run test:prod` runs it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { rollup, type OutputChunk, type Plugin, type RollupCache } from 'rollup';
import { minify as terser } from 'terser';
import { UPSTREAM_PKG, type Impl } from '../../harness/paths.ts';
import { create_resolver } from '../../harness/resolve.ts';

const ESM_ENV = '\0esm-env';

/**
 * Resolves and loads everything that is not the app's own: `svelte` leads to the
 * implementation, the way it does in the suite, and `esm-env` says that this is a production
 * build for the browser. The plugin for the app's own files has to come first.
 *
 * `dev` turns `DEV` on, to tell what a bundle does differently because of that flag from
 * what it does differently because it is a bundle.
 */
export function production(impl: Impl, { dev = false } = {}): Plugin {
	const { resolve, upstream_pkg } = create_resolver(impl);

	return {
		name: 'svelte-lite:production',

		resolveId(id, importer) {
			if (id === 'esm-env') return ESM_ENV;

			const resolved = resolve(id, importer);
			if (resolved) return resolved;

			if (id.startsWith('#')) {
				const entry = upstream_pkg.imports?.[id];
				const target = typeof entry === 'string' ? entry : entry?.default;
				return target ? path.resolve(UPSTREAM_PKG, target) : null;
			}

			if (id.startsWith('.')) return path.resolve(path.dirname(importer!), id);

			return fileURLToPath(import.meta.resolve(id));
		},

		load(id) {
			if (id !== ESM_ENV) return null;
			return `export const DEV = ${dev}; export const BROWSER = true; export const NODE = false;`;
		},

		async transform(code, id) {
			if (!id.endsWith('.ts')) return null;
			return (await transform(code, { loader: 'ts', target: 'esnext' })).code;
		}
	};
}

/**
 * Bundles into one ES module. With the `cache` of an earlier build, modules that were parsed
 * for that one are not parsed again. What ends up in the bundle is still decided per build.
 */
export async function bundle(
	input: string,
	plugins: Plugin[],
	options: { cache?: RollupCache | false } = {}
): Promise<{ chunk: OutputChunk; cache: RollupCache | undefined }> {
	const build = await rollup({ input, plugins, onwarn() {}, ...options });
	const { output } = await build.generate({ format: 'es' });
	await build.close();

	return { chunk: output[0], cache: build.cache };
}

export async function minify(code: string) {
	const minified = await terser(code, {
		module: true,
		toplevel: true,
		compress: { passes: 2 },
		mangle: true
	});

	return minified.code ?? '';
}
