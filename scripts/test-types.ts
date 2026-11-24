/**
 * Type-checks upstream's tests/types, which exercise the public types of `svelte`,
 * against svelte-lite, or against Svelte itself with SVELTE_IMPL=upstream.
 *
 * What covers something that svelte-lite does not have is left out when checking svelte-lite:
 *
 * - custom renderers: all of renderer.ts, and the statements that use `svelte/renderer`
 * - the deprecated API that svelte-lite removed (`harness/removed.ts`): the imports of what is
 *   gone, the statements that use it, and the removed options where they are passed
 *
 * A statement that declares something with what is left out takes the statements that use
 * that declaration with it.
 *
 *   bun run test:types          counts per file and the most common errors
 *   bun run test:types --all    every error
 */
import path from 'node:path';
import ts from 'typescript';
import { ROOT, UPSTREAM_PKG, UPSTREAM_TESTS, get_impl, is_inside } from '../harness/paths.ts';
import { REMOVED_EXPORTS, REMOVED_OPTIONS } from '../harness/removed.ts';
import { HarnessError, is_reused, read_package } from '../harness/resolve.ts';

const impl = get_impl();
const types = path.join(UPSTREAM_TESTS, 'types');

/** The entry point of custom renderers */
const RENDERER = 'svelte/renderer';

/** The test that covers nothing but custom renderers */
const RENDERER_TEST = path.join(types, 'renderer.ts');

const config = ts.getParsedCommandLineOfConfigFile(
	path.join(types, 'tsconfig.json'),
	{},
	{
		...ts.sys,
		onUnRecoverableConfigFileDiagnostic(diagnostic) {
			throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
		}
	}
)!;

let tests = config.fileNames;

if (impl === 'lite') {
	const paths: Record<string, string[]> = {};

	for (const [key, entry] of Object.entries(read_package(ROOT).exports)) {
		if (typeof entry === 'string') continue;
		paths[`svelte${key.slice(1)}`] = [entry.types ?? entry.browser ?? entry.default];
	}

	// An entry point that svelte-lite removed has nothing to resolve to. Without a mapping,
	// TypeScript would find Svelte's own through the package the tests live in
	for (const { module, names } of REMOVED_EXPORTS) {
		if (names === '*') paths[module] = ['harness/removed-entry-point.d.ts'];
	}

	// upstream maps `svelte` to its own sources here, this maps it to ours
	config.options.paths = paths;
	config.options.baseUrl = ROOT;
	config.options.rootDir = ROOT;
	config.options.allowImportingTsExtensions = true;

	tests = tests.filter((file) => path.resolve(file) !== RENDERER_TEST);
}

const program = ts.createProgram(tests, config.options);

if (impl === 'lite') {
	// Anything that `paths` does not cover resolves to the upstream package, and the tests
	// would then be checked against the types of real Svelte. The compiler and the server
	// runtime are Svelte's, and their types with them. A module that is still borrowed is
	// no exception: it brings the modules of Svelte that it imports, and their types.
	const leaked = program
		.getSourceFiles()
		.map((file) => path.resolve(file.fileName))
		.filter((file) => is_inside(file, UPSTREAM_PKG) && !is_inside(file, types) && !is_reused(file));

	if (leaked.length > 0) {
		const shown = leaked.slice(0, 10).map((file) => `\n  ${path.relative(ROOT, file)}`);
		const more = leaked.length > shown.length ? `\n  … and ${leaked.length - shown.length} more` : '';

		throw new HarnessError(
			`Type tests picked up real Svelte, which only the compiler and the server runtime ` +
				`may come from. \`bun run borrowed\` lists the modules that still re-export it.` +
				shown.join('') +
				more
		);
	}
}

interface LeftOut {
	/** What svelte-lite does not have, as the summary names it */
	feature: string;
	module: string;
	/** The names of `module` that are left out, `*` for all of them */
	names: '*' | Set<string>;
}

const LEFT_OUT: LeftOut[] = [
	{ feature: 'custom renderers', module: RENDERER, names: '*' },
	...REMOVED_EXPORTS.map(({ feature, module, names }) => ({
		feature,
		module,
		names: names === '*' ? ('*' as const) : new Set(names)
	}))
];

/** A part of a test, from `start` to `end`, that covers something svelte-lite leaves out */
interface Range {
	start: number;
	end: number;
	feature: string;
}

/**
 * The parts of a test that cover what svelte-lite leaves out: the imports of it, the top-level
 * statements that use it, directly or through something that such a statement declares, and
 * the removed options where they are passed. A range starts with the comments in front of
 * it: a `@ts-expect-error` that no longer has an error to expect is reported there.
 */
function left_out_ranges(file: ts.SourceFile): Range[] {
	const ranges: Range[] = [];
	const add = (node: ts.Node, feature: string) =>
		ranges.push({ start: node.getFullStart(), end: node.end, feature });

	/** local name → the feature that it stands for */
	const tainted = new Map<string, string>();

	/** local name → what it was imported as, and from where */
	const imported = new Map<string, { module: string; name: string }>();

	for (const statement of file.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;

		const module = statement.moduleSpecifier.text;
		const clause = statement.importClause;
		const bindings = clause?.namedBindings;
		const named = bindings && ts.isNamedImports(bindings) ? bindings.elements : [];

		for (const element of named) {
			imported.set(element.name.text, { module, name: (element.propertyName ?? element.name).text });
		}

		for (const left_out of LEFT_OUT) {
			if (left_out.module !== module) continue;

			if (left_out.names === '*') {
				add(statement, left_out.feature);
				if (clause?.name) tainted.set(clause.name.text, left_out.feature);
				if (bindings && ts.isNamespaceImport(bindings)) {
					tainted.set(bindings.name.text, left_out.feature);
				}
				for (const element of named) tainted.set(element.name.text, left_out.feature);
				continue;
			}

			for (const element of named) {
				if (left_out.names.has((element.propertyName ?? element.name).text)) {
					add(element, left_out.feature);
					tainted.set(element.name.text, left_out.feature);
				}
			}
		}
	}

	/** The feature of the first left-out name that `node` uses */
	const uses = (node: ts.Node): string | undefined =>
		(ts.isIdentifier(node) ? tainted.get(node.text) : undefined) ?? ts.forEachChild(node, uses);

	for (const statement of file.statements) {
		if (ts.isImportDeclaration(statement)) continue;

		const feature = uses(statement);
		if (!feature) continue;

		add(statement, feature);

		if (ts.isVariableStatement(statement)) {
			for (const { name } of statement.declarationList.declarations) {
				if (ts.isIdentifier(name)) tainted.set(name.text, feature);
			}
		} else if (
			(ts.isFunctionDeclaration(statement) ||
				ts.isClassDeclaration(statement) ||
				ts.isInterfaceDeclaration(statement) ||
				ts.isTypeAliasDeclaration(statement)) &&
			statement.name
		) {
			tainted.set(statement.name.text, feature);
		}
	}

	// a removed option, where it is passed to a function of svelte-lite in an object literal
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
			const callee = imported.get(node.expression.text);

			for (const removed of REMOVED_OPTIONS) {
				if (callee?.module !== removed.module || !removed.functions.includes(callee.name)) continue;

				for (const argument of node.arguments) {
					if (!ts.isObjectLiteralExpression(argument)) continue;

					for (const property of argument.properties) {
						if (property.name && ts.isIdentifier(property.name) && property.name.text === removed.option) {
							add(property, removed.feature);
						}
					}
				}
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(file);

	return ranges;
}

const ranges = new Map<ts.SourceFile, Range[]>();

/** What svelte-lite leaves out that an error is in a test of, if anything */
function left_out_feature({ file, start }: ts.Diagnostic) {
	if (impl !== 'lite' || !file || start === undefined || !is_inside(path.resolve(file.fileName), types)) {
		return undefined;
	}

	if (!ranges.has(file)) ranges.set(file, left_out_ranges(file));

	return ranges.get(file)!.find((range) => start >= range.start && start < range.end)?.feature;
}

const found = ts.getPreEmitDiagnostics(program);
const left_out = new Map<string, number>();
for (const { feature } of [...LEFT_OUT, ...REMOVED_OPTIONS]) left_out.set(feature, 0);

const diagnostics = found.filter((diagnostic) => {
	const feature = left_out_feature(diagnostic);
	if (feature) left_out.set(feature, left_out.get(feature)! + 1);
	return !feature;
});

const text = (d: ts.Diagnostic) => ts.flattenDiagnosticMessageText(d.messageText, ' ');

if (process.argv.includes('--all')) {
	console.log(
		ts.formatDiagnosticsWithColorAndContext(diagnostics, {
			getCanonicalFileName: (file) => file,
			getCurrentDirectory: () => ROOT,
			getNewLine: () => '\n'
		})
	);
} else if (diagnostics.length > 0) {
	const count = (keys: string[]) => {
		const counts = new Map<string, number>();
		for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
		return [...counts].sort((a, b) => b[1] - a[1]);
	};

	const files = count(diagnostics.map((d) => (d.file ? path.relative(ROOT, d.file.fileName) : '')));
	const messages = count(diagnostics.map(text));
	const width = String(Math.max(files[0][1], messages[0][1])).length;
	const row = ([key, n]: [string, number]) => `  ${String(n).padStart(width)}× ${key}`;

	console.log(files.map(row).join('\n'));
	console.log('\nMost common errors:');
	console.log(messages.slice(0, 8).map(row).join('\n'));
	if (messages.length > 8) console.log(`  … and ${messages.length - 8} other distinct messages`);
	console.log();
}

console.log(`${impl}: ${diagnostics.length} type errors in the ${tests.length} files of tests/types`);

if (impl === 'lite') {
	console.log('Left out, as svelte-lite does not have them:');

	for (const [feature, count] of left_out) {
		const whole = feature === 'custom renderers' ? `${path.basename(RENDERER_TEST)}, and ` : '';
		console.log(`  ${feature}: ${whole}${count} errors in statements that cover it`);
	}
}

process.exit(diagnostics.length > 0 ? 1 : 0);
