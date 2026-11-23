/**
 * Runs the unchanged test suite of the Svelte checkout in vendor/svelte, against
 * svelte-lite by default or against Svelte itself with SVELTE_IMPL=upstream.
 *
 * This mirrors vendor/svelte/vitest.config.js (the same projects and shards), with the
 * `svelte` alias replaced by harness/vite-plugin.ts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import { ROOT, UPSTREAM_ROOT, get_impl } from './harness/paths.ts';
import SummaryReporter from './harness/reporter.ts';
import { svelte_impl } from './harness/vite-plugin.ts';

/** The upstream config this file was last brought in line with */
const MIRRORED_CONFIG = 'c3ae8608a94b77ec006523a1608716750d76a01a5c750130bb0587246985f950';

const impl = get_impl();
const pkg = 'packages/svelte';

// The suite expects to be launched from the root of the Svelte repo. Expected output
// contains CSS hashes and warnings derived from filenames relative to the working
// directory, and `@vitest-environment` names a file relative to the root.
process.chdir(UPSTREAM_ROOT);

const upstream_config = fs.readFileSync(path.join(UPSTREAM_ROOT, 'vitest.config.js'));

if (crypto.createHash('sha256').update(upstream_config).digest('hex') !== MIRRORED_CONFIG) {
	console.warn(
		'vendor/svelte/vitest.config.js has changed since vitest.config.ts was written. ' +
			'Carry over what changed, then update MIRRORED_CONFIG.\n'
	);
}

const sharded_suites: Record<string, { count: number; isolate: string[] }> = {
	[`${pkg}/tests/runtime-runes/test.ts`]: { count: 4, isolate: ['inspect-trace'] },
	[`${pkg}/tests/runtime-legacy/test.ts`]: { count: 3, isolate: [] }
};

// vitest prints every failure in full, which is thousands of stack traces while
// most of svelte-lite is missing. FILTER narrows a run down far enough to want them.
const details = impl === 'upstream' || !!process.env.FILTER;

export default defineConfig({
	root: UPSTREAM_ROOT,
	// keeps vite's cache out of the submodule
	cacheDir: path.join(ROOT, 'node_modules/.vite'),
	test: {
		reporters: [...(details ? ['default'] : []), new SummaryReporter(impl)],
		testTimeout: 30_000,
		env: {
			// The suite reuses compiled samples in `_output/` unless upstream's compiler has
			// changed. That knows nothing of svelte-lite's compiler, and both implementations
			// write to the same directories, so a run could pick up the other one's output.
			NO_COMPILE_CACHE: 'true'
		},
		projects: [
			{
				extends: true,
				plugins: [svelte_impl(impl)],
				test: {
					name: 'svelte',
					include: [
						`${pkg}/**/*.test.ts`,
						`${pkg}/tests/*/test.ts`,
						`${pkg}/tests/runtime-browser/test-ssr.ts`
					],
					exclude: [
						...configDefaults.exclude,
						'**/samples/**',
						...Object.keys(sharded_suites),
						// runs in its own project with the server resolve condition
						`${pkg}/tests/custom-renderers-server/**`
					]
				}
			},
			...Object.entries(sharded_suites).flatMap(([file, { count, isolate }]) => {
				const suite = path.basename(path.dirname(file));

				const project = (
					name: string,
					shard: { index: number; count: number; include?: string; exclude?: string[] }
				) => ({
					extends: true as const,
					plugins: [svelte_impl(impl)],
					test: { name: `${suite} (${name})`, include: [file], provide: { shard } }
				});

				return [
					...Array.from({ length: count }, (_, index) =>
						project(`${index + 1}/${count}`, { index, count, exclude: isolate })
					),
					...isolate.map((prefix) => project(prefix, { index: 0, count: 1, include: prefix }))
				];
			}),
			{
				extends: true,
				// resolve `svelte` as if no `browser` condition was set
				plugins: [svelte_impl(impl, { force_server: true })],
				test: {
					name: 'custom-renderer-server',
					environment: 'node',
					include: [`${pkg}/tests/custom-renderers-server/test.ts`]
				}
			}
		]
	}
});
