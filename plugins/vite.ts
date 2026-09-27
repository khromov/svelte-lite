/**
 * Vite (Rolldown) versions of the Bun plugins, for build-vite.ts. They call the very same code as
 * the Bun build, so a Bun and a Vite build of one variant differ only in the bundler:
 *
 * - vitePatchPlugin:  loadPatched() from plugins/patch.ts (every patch + constImports, same anchors)
 * - viteSveltePlugin: compileSvelte() from plugins/svelte.ts (same compiler options, namedImports,
 *                     proxySet, build-time bans)
 *
 * plus two helpers that give build-vite.ts what Bun's metafile gives build.ts:
 * - viteResolutions:  what each bare import resolved to (for verifyResolution() in build.ts)
 * - viteMetafile:     per-module bytes, written in Bun's metafile shape (for measure.ts)
 */
import { relative } from 'node:path';
import type { Plugin } from 'vite';
import { loadPatched, runtimeFilter, type PatchPluginOptions } from './patch.ts';
import { compileSvelte, type SveltePluginOptions } from './svelte.ts';
import { ROOT } from '../scripts/link-svelte.ts';

/** Component CSS as a virtual module (vite-plugin-svelte's id scheme, so Vite's CSS pipeline picks it up). */
const STYLE = '?svelte&type=style&lang.css';
const STYLE_RE = /\?svelte&type=style&lang\.css$/;

export function vitePatchPlugin(opts: PatchPluginOptions): Plugin {
	if (!opts.patches?.length && !opts.constImports?.length) return { name: 'svelte-lite:patch' };
	return {
		name: 'svelte-lite:patch',
		enforce: 'pre',
		load: {
			filter: { id: runtimeFilter(opts.svelteDir) },
			async handler(id) {
				const code = await loadPatched(id, opts);
				return code === undefined ? null : { code, moduleType: 'js' };
			}
		}
	};
}

export function viteSveltePlugin(opts: SveltePluginOptions = {}): Plugin {
	const css = new Map<string, string>();
	return {
		name: 'svelte-lite:svelte',
		enforce: 'pre',
		resolveId: {
			filter: { id: STYLE_RE },
			handler: (id) => id
		},
		load: {
			filter: { id: [/\.svelte$/, /\.svelte\.(js|ts)$/, STYLE_RE] },
			async handler(id) {
				if (STYLE_RE.test(id)) return css.get(id) ?? '';
				let { code, css: style } = compileSvelte(id, await Bun.file(id).text(), opts);
				if (style) {
					css.set(id + STYLE, style);
					code += `\nimport ${JSON.stringify(id + STYLE)};`;
				}
				opts.onCompiled?.(id, code);
				return { code, moduleType: 'js' };
			}
		}
	};
}

type Inputs = Record<string, { imports: Array<{ path: string; original: string }> }>;

/** Records what every bare import resolved to, as the `inputs` of a Bun metafile. */
export function viteResolutions(inputs: Inputs): Plugin {
	return {
		name: 'svelte-lite:resolutions',
		enforce: 'pre',
		resolveId: {
			filter: { id: /^[\w@]/ },
			async handler(source, importer, options) {
				if (!importer) return null;
				const r = await this.resolve(source, importer, { ...options, skipSelf: true });
				if (r) (inputs[importer] ??= { imports: [] }).imports.push({ path: r.id, original: source });
				return null; // record only; resolution itself is Vite's
			}
		}
	};
}

/**
 * Writes `file` in the shape of Bun's metafile (`outputs[file].inputs[module].bytesInOutput`),
 * from Rolldown's per-module `renderedLength`: bytes after tree-shaking, before minification.
 */
export function viteMetafile(file: string): Plugin {
	return {
		name: 'svelte-lite:metafile',
		async generateBundle(_, bundle) {
			const outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }> = {};
			for (const chunk of Object.values(bundle)) {
				if (chunk.type !== 'chunk') continue;
				const inputs: Record<string, { bytesInOutput: number }> = {};
				for (const [id, m] of Object.entries(chunk.modules)) inputs[relative(ROOT, id)] = { bytesInOutput: m.renderedLength };
				outputs[chunk.fileName] = { inputs };
			}
			await Bun.write(file, JSON.stringify({ outputs }, null, 2));
		}
	};
}
