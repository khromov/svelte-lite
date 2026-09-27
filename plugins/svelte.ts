/**
 * Minimal Bun bundler plugin for Svelte 5, using the compiler from the linked Svelte
 * checkout (node_modules/svelte -> vendor/svelte/<ref>/packages/svelte; see scripts/link-svelte.ts).
 *
 * - `*.svelte`       -> compile()        (component)
 * - `*.svelte.js|ts` -> compileModule()  (runes in plain modules)
 * - component CSS    -> virtual `*.svelte.css` module bundled by Bun (`css: 'external'`)
 *
 * Client output can additionally be post-processed on the AST (acorn + magic-string from
 * the Svelte checkout's node_modules), per variant:
 * - `namedImports`: `import * as $ from 'svelte/internal/client'` -> named imports, so
 *   Bun's barrel optimisation (`optimizeImports`) can skip unused runtime modules.
 * - `proxySet`: `$.set(x, v, true)` -> `$.set(x, $.proxy(v))`, so the runtime's `set()`
 *   no longer needs a reference to `proxy()` (see the `proxy` patches).
 * - `forbid`: fail the build with a clear message if compiled output uses a runtime
 *   feature the variant removed (e.g. `$.transition`).
 */
import type { BunPlugin } from 'bun';
import { join } from 'node:path';
import { compile, compileModule } from 'svelte/compiler';
import type { CompileOptions, ModuleCompileOptions } from 'svelte/compiler';
import { SVELTE_DIR } from '../scripts/link-svelte.ts';
// @ts-ignore plain JS module shared with the Node-based test-suite harness
import { transformCompiled as sharedTransform } from './transform-compiled.js';

// acorn / magic-string come from the Svelte checkout's node_modules (no extra deps here).
const acorn: any = await import(Bun.resolveSync('acorn', join(SVELTE_DIR, 'src')));
const MagicString: any = (await import(Bun.resolveSync('magic-string', join(SVELTE_DIR, 'src')))).default;

export interface Forbidden {
	/** `$.<name>` runtime export used in compiled client output (called or referenced) */
	call: string;
	/** Only if the call's argument #index is an object literal with this property */
	withProp?: { index: number; name: string };
	message: string;
}

export interface SveltePluginOptions {
	/** 'client' (default) or 'server' (SSR bundle) */
	generate?: 'client' | 'server';
	/** Extra options merged into every compile() call. */
	compilerOptions?: Partial<CompileOptions>;
	/** Extra options merged into every compileModule() call. */
	moduleCompilerOptions?: Partial<ModuleCompileOptions>;
	/** Rewrite `import * as $` to named imports (enables optimizeImports). */
	namedImports?: boolean;
	/** Rewrite `$.set(x, v, true)` to `$.set(x, $.proxy(v))`. */
	proxySet?: boolean;
	/** Compiled-output features that must fail the build. */
	forbid?: Forbidden[];
	/** Called with every compiled module (for inspection/debugging). */
	onCompiled?: (file: string, js: string) => void;
}

const CSS_NAMESPACE = 'svelte-css';
const ts = new Bun.Transpiler({ loader: 'ts', target: 'browser' });

/** AST post-processing of compiled client output (see plugins/transform-compiled.js). */
export function transformCompiled(code: string, file: string, opts: SveltePluginOptions): string {
	return sharedTransform(code, file, opts, { acorn, MagicString });
}

export function sveltePlugin(opts: SveltePluginOptions = {}): BunPlugin {
	const generate = opts.generate ?? 'client';
	return {
		name: 'svelte',
		setup(build) {
			const css = new Map<string, string>();

			// Components
			build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
				const source = await Bun.file(path).text();
				const result = compile(source, {
					filename: path,
					generate,
					dev: false,
					css: 'external',
					...opts.compilerOptions
				});
				for (const w of result.warnings) console.warn(`[svelte] ${w.filename}: ${w.message}`);

				let code = result.js.code;
				if (generate === 'client') code = transformCompiled(code, path, opts);
				if (result.css?.code && generate === 'client') {
					const id = `${path}.css`;
					css.set(id, result.css.code);
					code += `\nimport ${JSON.stringify(id)};`;
				}
				opts.onCompiled?.(path, code);
				return { contents: code, loader: 'js' };
			});

			// Rune-enabled modules: foo.svelte.js / foo.svelte.ts
			build.onLoad({ filter: /\.svelte\.(js|ts)$/ }, async ({ path }) => {
				let source = await Bun.file(path).text();
				if (path.endsWith('.ts')) source = ts.transformSync(source);
				const result = compileModule(source, {
					filename: path,
					generate,
					dev: false,
					...opts.moduleCompilerOptions
				});
				for (const w of result.warnings) console.warn(`[svelte] ${w.filename}: ${w.message}`);
				const code = generate === 'client' ? transformCompiled(result.js.code, path, opts) : result.js.code;
				opts.onCompiled?.(path, code);
				return { contents: code, loader: 'js' };
			});

			// Virtual CSS modules emitted above (only when css: 'external').
			build.onResolve({ filter: /\.svelte\.css$/ }, ({ path }) => ({
				path,
				namespace: CSS_NAMESPACE
			}));
			build.onLoad({ filter: /.*/, namespace: CSS_NAMESPACE }, ({ path }) => ({
				contents: css.get(path) ?? '',
				loader: 'css'
			}));
		}
	};
}
