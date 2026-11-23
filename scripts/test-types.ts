/**
 * Type-checks upstream's tests/types, which exercise the public types of `svelte`,
 * against svelte-lite, or against Svelte itself with SVELTE_IMPL=upstream.
 *
 *   bun run test:types          counts per file and the most common errors
 *   bun run test:types --all    every error
 */
import path from 'node:path';
import ts from 'typescript';
import { ROOT, UPSTREAM_PKG, UPSTREAM_TESTS, get_impl, is_inside } from '../harness/paths.ts';
import { HarnessError, read_package } from '../harness/resolve.ts';

const impl = get_impl();
const types = path.join(UPSTREAM_TESTS, 'types');

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

if (impl === 'lite') {
	const paths: Record<string, string[]> = {};

	for (const [key, entry] of Object.entries(read_package(ROOT).exports)) {
		if (typeof entry === 'string') continue;
		paths[`svelte${key.slice(1)}`] = [entry.types ?? entry.browser ?? entry.default];
	}

	// upstream maps `svelte` to its own sources here, this maps it to ours
	config.options.paths = paths;
	config.options.baseUrl = ROOT;
	config.options.rootDir = ROOT;
	config.options.allowImportingTsExtensions = true;
}

const program = ts.createProgram(config.fileNames, config.options);

if (impl === 'lite') {
	// anything that `paths` does not cover resolves to the upstream package, and
	// the tests would then be checked against the types of real Svelte
	const leaked = program
		.getSourceFiles()
		.map((file) => path.resolve(file.fileName))
		.filter((file) => is_inside(file, UPSTREAM_PKG) && !is_inside(file, types));

	if (leaked.length > 0) {
		throw new HarnessError(
			`Type tests picked up real Svelte: ${leaked.map((f) => path.relative(ROOT, f)).join(', ')}`
		);
	}
}

const diagnostics = ts.getPreEmitDiagnostics(program);
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

const checked = config.fileNames.length;
console.log(`${impl}: ${diagnostics.length} type errors in the ${checked} files of tests/types`);

process.exit(diagnostics.length > 0 ? 1 : 0);
