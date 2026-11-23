import fs from 'node:fs';
import path from 'node:path';
import { COMPAT, ROOT, UPSTREAM_PKG, UPSTREAM_SRC, is_inside, type Impl } from './paths.ts';

/** Thrown when the harness itself is misconfigured, as opposed to a test failing */
export class HarnessError extends Error {
	override name = 'HarnessError';
}

type ExportEntry = string | Record<string, string>;

export interface PackageJson {
	name: string;
	version: string;
	exports: Record<string, ExportEntry>;
	imports?: Record<string, ExportEntry>;
}

export function read_package(dir: string): PackageJson {
	return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

/** Strips the decorations bundlers add to module ids, leaving a file path */
export function clean_id(id: string) {
	return id.replace(/^\0/, '').replace(/^\/@fs\//, '/').replace(/[?#].*$/, '');
}

/** `svelte` → `.`, `svelte/store` → `./store`, anything else → `null` */
export function svelte_subpath(specifier: string) {
	if (specifier === 'svelte') return '.';
	if (specifier.startsWith('svelte/')) return `./${specifier.slice('svelte/'.length)}`;
	return null;
}

/**
 * Picks an export target the way upstream's `vitest.config.js` does: the client (`browser`)
 * build, unless the server build is asked for.
 */
export function resolve_export(
	pkg_dir: string,
	pkg: PackageJson,
	subpath: string,
	use_server: boolean
) {
	const entry = pkg.exports[subpath];
	if (entry === undefined) return null;

	const target =
		typeof entry === 'string' ? entry : use_server ? entry.default : entry.browser ?? entry.default;

	return target ? path.resolve(pkg_dir, target) : null;
}

/** Finds the file that an extensionless or directory import of `target` refers to */
function resolve_file(target: string) {
	const candidates = [
		target,
		`${target}.js`,
		`${target}.ts`,
		`${target}.d.ts`,
		path.join(target, 'index.js'),
		path.join(target, 'index.ts')
	];

	return candidates.find((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile()) ?? null;
}

/**
 * If `specifier`, as imported by a file inside the upstream package, refers to a module in
 * upstream's `src/` — through a relative path or a `#subpath` import — returns that module.
 */
export function upstream_src_target(specifier: string, importer: string, upstream_pkg: PackageJson) {
	if (!is_inside(importer, UPSTREAM_PKG)) return null;

	let target: string;

	if (specifier.startsWith('#')) {
		const entry = upstream_pkg.imports?.[specifier];
		const mapped = typeof entry === 'string' ? entry : entry?.default;
		if (!mapped) return null;
		target = path.resolve(UPSTREAM_PKG, mapped);
	} else if (specifier.startsWith('.')) {
		target = path.resolve(path.dirname(importer), specifier);
	} else {
		return null;
	}

	return is_inside(target, UPSTREAM_SRC) ? resolve_file(target) : null;
}

/** The compat shim that stands in for an upstream `src/` module */
export function to_compat(upstream_file: string) {
	const relative = path.relative(UPSTREAM_SRC, upstream_file).replace(/(\.d)?\.[jt]s$/, '');
	return path.join(COMPAT, `${relative}.ts`);
}

/** As `to_compat`, but the shim has to exist */
export function require_compat(upstream_file: string, importer?: string) {
	const shim = to_compat(upstream_file);

	if (!fs.existsSync(shim)) {
		const from = importer ? `, imported by ${path.relative(UPSTREAM_PKG, importer)}` : '';
		throw new HarnessError(
			`Missing compat shim ${path.relative(ROOT, shim)} ` +
				`(stands in for upstream src/${path.relative(UPSTREAM_SRC, upstream_file)}${from}). ` +
				`Run \`bun run compat:audit --scaffold\` to create it.`
		);
	}

	return shim;
}

/**
 * In `lite` mode nothing from the real Svelte may be loaded, otherwise tests would
 * quietly pass against the wrong implementation. Co-located `*.test.ts` files are
 * the one thing in upstream's `src/` that is part of the suite.
 */
export function assert_not_upstream(file: string) {
	const leaked =
		(is_inside(file, UPSTREAM_SRC) && !file.endsWith('.test.ts')) ||
		file.includes('/node_modules/svelte/');

	if (leaked) {
		throw new HarnessError(
			`Refusing to load real Svelte source while testing svelte-lite: ${path.relative(ROOT, file)}`
		);
	}
}

/**
 * Creates the function that decides where imports made by the upstream suite end up.
 * Returns `null` for anything the bundler should resolve by itself.
 */
export function create_resolver(impl: Impl, options: { force_server?: boolean } = {}) {
	const upstream_pkg = read_package(UPSTREAM_PKG);
	const pkg_dir = impl === 'lite' ? ROOT : UPSTREAM_PKG;
	const pkg = impl === 'lite' ? read_package(ROOT) : upstream_pkg;

	return (specifier: string, importer: string | undefined) => {
		const subpath = svelte_subpath(specifier);

		if (subpath !== null) {
			// compiled server output has to get the server build of the runtime
			const use_server = options.force_server || !!importer?.includes('_output/server');
			const resolved = resolve_export(pkg_dir, pkg, subpath, use_server);

			// falling through would let the bundler resolve `svelte` as a self-reference
			// of the upstream package, so in `lite` mode this has to be an error
			if (!resolved && impl === 'lite') {
				throw new HarnessError(`svelte-lite has no runtime export for "${specifier}"`);
			}

			return resolved;
		}

		if (impl === 'upstream' || !importer) return null;

		const file = clean_id(importer);
		const upstream_file = upstream_src_target(specifier, file, upstream_pkg);

		return upstream_file && require_compat(upstream_file, file);
	};
}
