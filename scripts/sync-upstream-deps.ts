/**
 * Pins this repo's dependencies to the versions in upstream's lockfile, so that the
 * suite runs on the same jsdom, vitest, parser etc. as it does in the Svelte repo.
 * Expected output in the samples depends on those, down to transitive dependencies.
 *
 * Dependencies that upstream also has are pinned in `devDependencies`, and everything
 * they pull in is pinned through `overrides`. Run this after moving the submodule.
 */
import path from 'node:path';
import { $ } from 'bun';
import { ROOT, UPSTREAM_ROOT } from '../harness/paths.ts';

type Versions = Record<string, string>;

interface Lockfile {
	importers: Record<
		string,
		Partial<Record<'dependencies' | 'devDependencies', Record<string, { version: string }>>>
	>;
	snapshots: Record<string, { dependencies?: Versions }>;
}

const lock: Lockfile = Bun.YAML.parse(
	await Bun.file(path.join(UPSTREAM_ROOT, 'pnpm-lock.yaml')).text()
) as Lockfile;

/** `4.1.7(@types/node@20.19.17)(jsdom@25.0.1)` → `4.1.7` */
const bare = (version: string) => version.replace(/\(.*$/, '');

/** Everything upstream depends on directly, with the peer suffix that snapshot keys have */
const direct: Versions = {};

for (const importer of ['.', 'packages/svelte']) {
	const { dependencies, devDependencies } = lock.importers[importer];

	for (const [name, { version }] of Object.entries({ ...devDependencies, ...dependencies })) {
		if (!version.startsWith('link:')) direct[name] = version;
	}
}

const package_file = path.join(ROOT, 'package.json');
const pkg = await Bun.file(package_file).json();
const own: Versions = pkg.devDependencies;

/** Every version of every package that our shared dependencies pull in */
const closure = new Map<string, Set<string>>();
const queue = Object.keys(own)
	.filter((name) => direct[name])
	.map((name) => `${name}@${direct[name]}`);
const seen = new Set(queue);

for (const key of queue) {
	// optional dependencies are platform-specific binaries, which their parent pins exactly
	for (const [name, version] of Object.entries(lock.snapshots[key]?.dependencies ?? {})) {
		// an aliased dependency has the key of its target as its version
		const child = lock.snapshots[version] ? version : `${name}@${version}`;
		const target = child.slice(0, child.indexOf('@', 1));

		closure.set(target, (closure.get(target) ?? new Set()).add(bare(child.slice(target.length + 1))));

		if (!seen.has(child)) {
			seen.add(child);
			queue.push(child);
		}
	}
}

const overrides: Versions = {};
const ambiguous: string[] = [];

for (const name of [...closure.keys()].sort()) {
	const versions = [...closure.get(name)!];

	if (own[name]) {
		// ours directly, but upstream only has it through something else (vite)
		if (!direct[name] && versions.length === 1) direct[name] = versions[0];
	} else if (versions.length === 1) {
		overrides[name] = versions[0];
	} else {
		ambiguous.push(`${name} (${versions.join(', ')})`);
	}
}

const expected: Versions = { ...overrides };

for (const name of Object.keys(own)) {
	if (!direct[name]) continue;
	expected[name] = own[name] = bare(direct[name]);
}

pkg.overrides = overrides;
await Bun.write(package_file, JSON.stringify(pkg, null, '\t') + '\n');
await $`bun install`.cwd(ROOT).quiet();

const mismatched: string[] = [];

for (const [name, version] of Object.entries(expected)) {
	const file = Bun.file(path.join(ROOT, 'node_modules', name, 'package.json'));
	const installed = (await file.exists()) ? (await file.json()).version : 'not installed';

	if (installed !== version) mismatched.push(`${name}: expected ${version}, found ${installed}`);
}

const unpinned = Object.keys(own).filter((name) => !direct[name]);

console.log(
	`Pinned ${Object.keys(expected).length - Object.keys(overrides).length} dependencies ` +
		`and ${Object.keys(overrides).length} overrides to upstream's lockfile`
);
console.log(`Not in upstream's lockfile, left as they are: ${unpinned.join(', ') || 'none'}`);

if (ambiguous.length > 0) {
	console.log(`Upstream has several versions, left to the resolver: ${ambiguous.join(', ')}`);
}

if (mismatched.length > 0) {
	console.log(`\nInstalled versions that differ from upstream's:\n  ${mismatched.join('\n  ')}`);
	process.exit(1);
}
