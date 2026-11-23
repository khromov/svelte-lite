/**
 * Stands in for `esbuild` when the upstream browser suite imports it while testing
 * svelte-lite. esbuild resolves imports without going through Vite, and would resolve
 * `svelte` to the upstream package the test files live in, so its builds get the same
 * redirects as everything else.
 */
import * as esbuild from 'esbuild';
import { ROOT, UPSTREAM_SRC, is_inside } from './paths.ts';
import { create_resolver, is_reused, read_package, require_compat, to_own } from './resolve.ts';
import fs from 'node:fs';

export * from 'esbuild';

export function build(options: esbuild.BuildOptions) {
	return esbuild.build({
		// a failed build rejects with its errors either way, printing them as well buries
		// the summary of a full run while most of svelte-lite is missing
		logLevel: process.env.FILTER ? 'warning' : 'silent',
		...options,
		// the suite's own plugins go first, so that they keep the last word on what gets resolved
		plugins: [...(options.plugins ?? []).map(redirect_results), svelte_lite()]
	});
}

/** Rewrites upstream `src/` paths that one of the suite's plugins resolved to by hand */
function redirect_results(plugin: esbuild.Plugin): esbuild.Plugin {
	return {
		name: plugin.name,
		setup(build) {
			return plugin.setup({
				...build,
				onResolve(options, callback) {
					build.onResolve(options, async (args) => {
						const result = await callback(args);

						if (result?.path && is_inside(result.path, UPSTREAM_SRC)) {
							const own = to_own(result.path);
							if (fs.existsSync(own)) return { ...result, path: own };
							if (!is_reused(result.path)) {
								return { ...result, path: require_compat(result.path, args.importer) };
							}
						}

						return result;
					});
				}
			});
		}
	};
}

function svelte_lite(): esbuild.Plugin {
	const { resolve, check_load } = create_resolver('lite');
	const { name } = read_package(ROOT);

	return {
		name: 'svelte-lite:impl',
		setup(build) {
			// resolving the package through its own name lets esbuild pick the export
			// condition, the same way it would for an installed copy
			build.onResolve({ filter: /^svelte(\/|$)/ }, async (args) => {
				const result = await build.resolve(name + args.path.slice('svelte'.length), {
					kind: args.kind,
					resolveDir: ROOT
				});

				return result.errors.length > 0 ? { errors: result.errors } : { path: result.path };
			});

			build.onResolve({ filter: /^[.#]/ }, (args) => {
				const resolved = resolve(args.path, args.importer);
				return resolved ? { path: resolved } : undefined;
			});

			build.onLoad({ filter: /.*/ }, (args) => {
				check_load(args.path);
				return undefined;
			});
		}
	};
}
