/**
 * Single source of truth for WHICH Svelte the project builds against and WHERE it lives.
 *
 * Selection (first match wins):
 *   1. `--svelte=<ref>` on the command line of any script that imports this module
 *      (propagated to child processes as SVELTE_REF)
 *   2. SVELTE_DIR=/path/to/svelte/packages/svelte: escape hatch, any checkout (e.g. ../svelte)
 *   3. SVELTE_REF=<ref>: a ref vendored under vendor/svelte/ (`main`, `5.57.1`, a dir name)
 *   4. svelte-ref.json: the active selection written by `bun run vendor <ref>`
 *      (scripts/vendor-svelte.ts); its sha is enforced
 *
 * Exports: SVELTE_DIR (packages/svelte), SVELTE_REPO (monorepo root: pnpm-workspace.yaml,
 * vitest.config.js, node_modules), SVELTE_INFO ({ repo, ref, tag, sha, version, path, via }),
 * SVELTE_SHA, SVELTE_VERSION, svelteLabel(), ensureSvelteLink(), assertPristine().
 * Importing this module throws a clear error when the selected ref isn't vendored.
 *
 * node_modules/svelte is a plain symlink to SVELTE_DIR (re-pointed atomically whenever the
 * selection changes), not `file:`/`link:` in package.json: `file:` would install all of
 * Svelte's (dev)dependencies into this project and `link:` needs global `bun link`. Bun
 * follows the symlink to the real path, so `svelte`, `svelte/internal/*` and `#client/*`
 * resolve through Svelte's own package.json `exports`/`imports`, and Svelte's dependencies
 * (esm-env, clsx, acorn, ...) come from the checkout's pnpm node_modules.
 * The symlink is shared state: two concurrent builds with different refs would race on it.
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { headSha, LOCK_FILE, parseRef, readJson, readLock, readMarker, VENDOR_ROOT, ROOT } from './vendor-svelte.ts';

export { ROOT };

export interface SvelteInfo {
	/** how this Svelte was selected */
	via: 'svelte-ref.json' | 'SVELTE_REF' | '--svelte' | 'SVELTE_DIR';
	/** git remote it came from (null if unknown) */
	repo: string | null;
	/** selected ref: '5.57.1', 'main', a sha; for SVELTE_DIR `git describe` output */
	ref: string;
	/** upstream release tag at this commit ('svelte@5.57.1'), else null */
	tag: string | null;
	/** exact commit (null if SVELTE_DIR is not a git checkout) */
	sha: string | null;
	/** packages/svelte/package.json version */
	version: string;
	/** monorepo root, relative to the project root */
	path: string;
	/** set by assertPristine() if packages/svelte has local changes and SVELTE_ALLOW_DIRTY=1 */
	dirty?: boolean;
}

type Selection = { dir: string; repoRoot: string; info: SvelteInfo } | { error: string };

const git = (cwd: string, args: string[]) => {
	const r = Bun.spawnSync(['git', '--no-optional-locks', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
	return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};
const version = (pkgDir: string) => readJson<{ version: string }>(join(pkgDir, 'package.json'))?.version ?? '?';

/** A vendored checkout (vendor/svelte/<slug>), selected via SVELTE_REF/--svelte or svelte-ref.json. */
function fromCheckout(repoRoot: string, via: SvelteInfo['via'], hint: string): Selection {
	const marker = readMarker(repoRoot);
	if (!marker || !existsSync(join(repoRoot, 'packages', 'svelte', 'package.json'))) {
		return { error: `Svelte ${hint} is not vendored yet (${relative(ROOT, repoRoot)} missing or incomplete): run \`bun run vendor ${hint}\`` };
	}
	if (!marker.install) {
		return { error: `${relative(ROOT, repoRoot)} has no installed dependencies: run \`bun run vendor ${marker.ref}\`` };
	}
	const sha = headSha(repoRoot);
	if (sha !== marker.sha) {
		return {
			error: `${relative(ROOT, repoRoot)} was vendored at ${marker.sha.slice(0, 12)} but HEAD is now ${sha?.slice(0, 12)}; ` +
				`run \`bun run vendor ${marker.ref} --update\` (or \`--force\` to reset it)`
		};
	}
	const dir = join(repoRoot, 'packages', 'svelte');
	return {
		dir,
		repoRoot,
		info: { via, repo: marker.repo, ref: marker.ref, tag: marker.tag, sha, version: version(dir), path: relative(ROOT, repoRoot) }
	};
}

function fromRef(input: string, via: SvelteInfo['via']): Selection {
	// a vendor/svelte/<dir> name (e.g. main--khromov-svelte) or a ref of the default repo
	const direct = join(VENDOR_ROOT, input);
	if (!input.includes('/') && existsSync(join(direct, '.git'))) return fromCheckout(direct, via, input);
	let slug: string;
	try {
		slug = parseRef(input).slug;
	} catch (e: any) {
		return { error: `${via}=${input}: ${e.message}` };
	}
	return fromCheckout(join(VENDOR_ROOT, slug), via, input);
}

function fromLock(): Selection {
	const lock = readLock();
	if (!lock) {
		return {
			error: `no Svelte selected (${relative(ROOT, LOCK_FILE)} missing): run \`bun run vendor 5.57.1\` (or \`main\`), ` +
				`or set SVELTE_DIR=/path/to/svelte/packages/svelte`
		};
	}
	const repoRoot = resolve(ROOT, lock.path);
	const sel = fromCheckout(repoRoot, 'svelte-ref.json', lock.ref);
	if ('error' in sel) {
		return existsSync(join(repoRoot, '.git'))
			? sel
			: { error: `svelte-ref.json selects ${lock.tag ?? lock.ref} @ ${lock.sha.slice(0, 12)} but ${lock.path} is missing: run \`bun run vendor\` (re-creates exactly that commit)` };
	}
	if (sel.info.sha !== lock.sha) {
		return {
			error: `${lock.path} is at ${sel.info.sha?.slice(0, 12)} but svelte-ref.json pins ${lock.sha.slice(0, 12)}: ` +
				`run \`bun run vendor\` to restore the pinned commit, or \`bun run vendor ${lock.ref} --update\` to pin what is upstream now`
		};
	}
	return sel;
}

/** SVELTE_DIR escape hatch: any Svelte package directory, git checkout or not. */
function fromDir(pkgDir: string): Selection {
	if (!existsSync(join(pkgDir, 'package.json'))) return { error: `SVELTE_DIR=${pkgDir}: no package.json there` };
	let repoRoot = pkgDir;
	for (let d = pkgDir, i = 0; i < 4 && d !== dirname(d); d = dirname(d), i++) {
		if (existsSync(join(d, 'pnpm-workspace.yaml'))) {
			repoRoot = d;
			break;
		}
	}
	const marker = readMarker(repoRoot);
	const sha = headSha(repoRoot);
	const tag = marker?.tag ?? git(repoRoot, ['tag', '--points-at', 'HEAD'])?.split('\n').find((t) => t.startsWith('svelte@')) ?? null;
	return {
		dir: pkgDir,
		repoRoot,
		info: {
			via: 'SVELTE_DIR',
			repo: marker?.repo ?? git(repoRoot, ['remote', 'get-url', 'origin']),
			ref: marker?.ref ?? git(repoRoot, ['describe', '--tags', '--always']) ?? 'unknown',
			tag,
			sha,
			version: version(pkgDir),
			path: relative(ROOT, repoRoot)
		}
	};
}

function select(): Selection {
	const flag = process.argv.find((a) => a.startsWith('--svelte='))?.slice('--svelte='.length);
	if (flag) {
		// children spawned with `env: process.env` must resolve the same Svelte
		process.env.SVELTE_REF = flag;
		delete process.env.SVELTE_DIR;
		return fromRef(flag, '--svelte');
	}
	if (process.env.SVELTE_DIR) return fromDir(resolve(process.env.SVELTE_DIR));
	if (process.env.SVELTE_REF) return fromRef(process.env.SVELTE_REF, 'SVELTE_REF');
	return fromLock();
}

const selection = select();
if ('error' in selection) {
	if (import.meta.main) {
		// postinstall on a fresh clone: don't fail `bun install`, just say what to do next
		console.warn(`[svelte-lite] ${selection.error}`);
		process.exit(0);
	}
	throw new Error(`[svelte-lite] ${selection.error}`);
}

/** packages/svelte of the selected checkout */
export const SVELTE_DIR = selection.dir;
/** monorepo root of the selected checkout (pnpm-workspace.yaml, vitest.config.js, node_modules) */
export const SVELTE_REPO = selection.repoRoot;
/** provenance of the selected Svelte */
export const SVELTE_INFO: SvelteInfo = selection.info;
export const SVELTE_SHA = SVELTE_INFO.sha;
export const SVELTE_VERSION = SVELTE_INFO.version;

/** e.g. "svelte 5.57.1 (svelte@5.57.1 @ 636eaaaa6f06, vendor/svelte/5.57.1, via svelte-ref.json)" */
export function svelteLabel(i: SvelteInfo = SVELTE_INFO) {
	const what = [i.tag ?? i.ref, i.sha ? `@ ${i.sha.slice(0, 12)}` : ''].filter(Boolean).join(' ');
	const repo = i.repo && !/github\.com\/sveltejs\/svelte(\.git)?$/.test(i.repo) ? `, ${i.repo}` : '';
	return `svelte ${i.version} (${what}${i.dirty ? ' + LOCAL CHANGES' : ''}, ${i.path}${repo}, via ${i.via})`;
}

/**
 * "Official Svelte source + our documented patches" must stay true: fail if packages/svelte
 * has uncommitted changes (tracked or untracked). SVELTE_ALLOW_DIRTY=1 downgrades this to a
 * warning and marks SVELTE_INFO.dirty (stamped into report.json).
 */
export function assertPristine() {
	const pkg = relative(SVELTE_REPO, SVELTE_DIR) || '.';
	const status = git(SVELTE_REPO, ['status', '--porcelain', '--', pkg]);
	if (status === null) {
		console.warn(`[svelte-lite] warning: ${SVELTE_REPO} is not a git checkout; cannot verify that ${pkg} is unmodified`);
		return;
	}
	if (!status) return;
	const msg =
		`[svelte-lite] ${join(SVELTE_INFO.path, pkg)} has uncommitted changes, so the build would not be ` +
		`"official Svelte ${SVELTE_INFO.tag ?? SVELTE_INFO.ref} + documented patches":\n${status}\n` +
		`Discard them (git -C ${SVELTE_REPO} checkout -- ${pkg} && git -C ${SVELTE_REPO} clean -fd -- ${pkg}), ` +
		`or set SVELTE_ALLOW_DIRTY=1 to build anyway (reports are stamped "dirty").`;
	if (process.env.SVELTE_ALLOW_DIRTY !== '1') throw new Error(msg);
	console.warn(msg.replace('[svelte-lite]', '[svelte-lite] WARNING:'));
	SVELTE_INFO.dirty = true;
}

/** Point node_modules/svelte at SVELTE_DIR (atomically), after checking the source is pristine. */
export function ensureSvelteLink({ guard = true } = {}): string {
	if (guard) assertPristine();
	const nm = join(ROOT, 'node_modules');
	const link = join(nm, 'svelte');
	mkdirSync(nm, { recursive: true });
	let stat;
	try {
		stat = lstatSync(link);
	} catch {}
	if (stat && !stat.isSymbolicLink()) throw new Error(`${link} exists and is not a symlink; remove it first`);
	if (stat && resolve(nm, readlinkSync(link)) === SVELTE_DIR) return link;
	// relative when inside the project (vendor/), so the project directory stays relocatable
	const target = SVELTE_DIR.startsWith(ROOT + '/') ? relative(nm, SVELTE_DIR) : SVELTE_DIR;
	const tmp = `${link}.tmp-${process.pid}`;
	symlinkSync(target, tmp, 'dir');
	renameSync(tmp, link); // atomic replace: concurrent resolvers never see a missing link
	console.log(`linked node_modules/svelte -> ${isAbsolute(target) ? target : relative(ROOT, SVELTE_DIR)}`);
	return link;
}

if (import.meta.main) {
	// postinstall / `bun run setup`
	try {
		assertPristine();
	} catch (e: any) {
		console.warn(e.message);
	}
	ensureSvelteLink({ guard: false });
	console.log(svelteLabel());
}
