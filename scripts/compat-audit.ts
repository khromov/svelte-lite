/**
 * Works out which modules of upstream's `src/` the upstream tests import, and which
 * names they use from each, then checks that against the shims in compat/.
 *
 *   bun run compat:audit              report missing shims and missing exports
 *   bun run compat:audit --scaffold   also create the shim files that are missing
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { COMPAT, ROOT, UPSTREAM_PKG, UPSTREAM_SRC, UPSTREAM_TESTS } from '../harness/paths.ts';
import { is_reused, read_package, to_compat, to_own, upstream_src_target } from '../harness/resolve.ts';

const scaffold = process.argv.includes('--scaffold');
const upstream_pkg = read_package(UPSTREAM_PKG);
const relative = (file: string) => path.relative(ROOT, file);

/** upstream module → the names the tests use from it */
const needed = new Map<string, Set<string>>();

function need(specifier: string, importer: string, names: string[]) {
	const file = upstream_src_target(specifier, importer, upstream_pkg);

	// declaration files only ever provide types
	if (!file || file.endsWith('.d.ts')) return;

	const set = needed.get(file) ?? new Set();
	for (const name of names) set.add(name);
	needed.set(file, set);
}

function scan(file: string, text: string) {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true);

	/** `import * as $` bindings, whose members are only known from how `$` is used */
	const namespaces = new Map<string, string>();

	function visit(node: ts.Node) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			const clause = node.importClause;
			const names: string[] = [];

			if (clause && !clause.isTypeOnly) {
				if (clause.name) names.push('default');

				if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
					for (const element of clause.namedBindings.elements) {
						if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
					}
				} else if (clause.namedBindings) {
					namespaces.set(clause.namedBindings.name.text, node.moduleSpecifier.text);
				}
			}

			if (!clause?.isTypeOnly) need(node.moduleSpecifier.text, file, names);
			return;
		}

		if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
			if (ts.isStringLiteral(node.moduleSpecifier)) {
				const names =
					node.exportClause && ts.isNamedExports(node.exportClause)
						? node.exportClause.elements
								.filter((element) => !element.isTypeOnly)
								.map((element) => (element.propertyName ?? element.name).text)
						: [];

				need(node.moduleSpecifier.text, file, names);
			}
			return;
		}

		// `import('…')`, and paths into `src/` that are built by hand, such as
		// `path.resolve(__dirname, '../../src/index-server.js')`
		if (ts.isStringLiteral(node) && !ts.isLiteralTypeNode(node.parent)) {
			if (node.text.startsWith('.') || node.text.startsWith('#')) need(node.text, file, []);
		}

		if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
			const specifier = namespaces.get(node.expression.text);
			if (specifier) need(specifier, file, [node.name.text]);
		}

		ts.forEachChild(node, visit);
	}

	visit(source);
}

function exported_names(files: string[]) {
	const program = ts.createProgram(files, {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		allowImportingTsExtensions: true,
		allowJs: true,
		noEmit: true,
		skipLibCheck: true
	});

	const checker = program.getTypeChecker();

	return new Map(
		files.map((file) => {
			const symbol = checker.getSymbolAtLocation(program.getSourceFile(file)!);
			const names = symbol ? checker.getExportsOfModule(symbol).map((s) => s.name) : [];
			return [file, new Set(names)];
		})
	);
}

function create_shim(upstream_file: string, shim: string) {
	const own = to_own(upstream_file);

	// svelte-lite's module if there is one, Svelte's if it is part of what svelte-lite reuses
	const target = fs.existsSync(own) ? own : is_reused(upstream_file) ? upstream_file : null;
	const from = target && path.relative(path.dirname(shim), target);

	fs.mkdirSync(path.dirname(shim), { recursive: true });
	fs.writeFileSync(
		shim,
		`// Stands in for upstream src/${path.relative(UPSTREAM_SRC, upstream_file)}\n` +
			(from ? `export * from '${from}';\n` : 'export {};\n')
	);
}

const sources = [
	...new Bun.Glob('**/*.{js,ts}').scanSync({ cwd: UPSTREAM_TESTS, absolute: true }),
	...new Bun.Glob('**/*.test.ts').scanSync({ cwd: UPSTREAM_SRC, absolute: true })
];

for (const file of sources) {
	if (file.includes('/_output/') || file.includes('/node_modules/') || file.endsWith('.d.ts')) {
		continue;
	}

	const text = fs.readFileSync(file, 'utf8');
	const in_tests = file.startsWith(UPSTREAM_TESTS);

	// almost none of the ~4,000 files under tests/ reach into src/, skip parsing those
	if (in_tests && !/src\/|['"`]#/.test(text)) continue;

	scan(file, text);
}

const shims = new Map([...needed.keys()].sort().map((file) => [file, to_compat(file)]));
let created = 0;

for (const [file, shim] of shims) {
	if (scaffold && !fs.existsSync(shim)) {
		create_shim(file, shim);
		created += 1;
	}
}

const present = [...shims.values()].filter((shim) => fs.existsSync(shim));
const exports = exported_names(present);
const width = Math.max(...[...shims.values()].map((shim) => relative(shim).length));

let missing_files = 0;
let missing_names = 0;

for (const [file, shim] of shims) {
	const names = [...needed.get(file)!].sort();
	const available = exports.get(shim);
	const missing = available ? names.filter((name) => !available.has(name)) : names;

	let status = 'ok';

	if (!available) {
		status = 'NO FILE';
		missing_files += 1;
	} else if (missing.length > 0) {
		status = `${missing.length} missing`;
		missing_names += missing.length;
	}

	console.log(`${status.padEnd(11)} ${relative(shim).padEnd(width)}  ${missing.join(', ')}`);
}

const existing = fs.existsSync(COMPAT)
	? [...new Bun.Glob('**/*.ts').scanSync({ cwd: COMPAT, absolute: true })]
	: [];
const unused = existing.filter((file) => !present.includes(file));

console.log();
console.log(
	`${shims.size} shims needed: ${missing_files} without a file, ` +
		`${missing_names} exports missing` +
		(created ? `, ${created} files created` : '')
);

if (unused.length > 0) {
	console.log(`No longer imported by any test: ${unused.map(relative).join(', ')}`);
}

// a missing file stops every test that imports it from loading, missing exports
// only fail the tests that use them
if (missing_files > 0) {
	console.log('Run `bun run compat:audit --scaffold` to create the missing files');
	process.exit(1);
}
