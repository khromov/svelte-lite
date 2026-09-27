#!/usr/bin/env bun
/**
 * Vendors the official Svelte monorepo into this project and selects it for the build.
 *
 *   bun run vendor <ref>              fetch + install + make it the active Svelte (svelte-ref.json)
 *   bun run vendor                    re-create the checkout pinned in svelte-ref.json (fresh clone)
 *   bun run vendor main --update      fetch the latest `main` (for tags: re-verify the tag)
 *   bun run vendor --list             vendored refs (* = active)
 *
 *   <ref>   main | 5.57.1 (-> tag svelte@5.57.1) | svelte@5.57.1 | <40-char commit sha>
 *           | any other branch or tag name of the repo
 *   --repo=<url|path>   source repo (default https://github.com/sveltejs/svelte.git)
 *   --no-activate       vendor only; leave svelte-ref.json alone
 *   --no-install        skip `pnpm install`
 *   --reinstall         run `pnpm install` even if the lockfile didn't change
 *   --force             allow moving a checkout that has local changes (they are discarded)
 *
 * Layout: one independent shallow clone per ref, vendor/svelte/<slug>/ (slug = 5.57.1, main,
 * commit-<sha12>, ...; refs from a non-default --repo get a `--<owner>-<name>` suffix).
 * A shallow clone of one commit is ~3 MB of git objects and takes ~1-2 s, so sharing an
 * object store between refs (git worktree) would save almost nothing, while independent
 * clones need no worktree bookkeeping, contain no absolute paths in `.git`, can be deleted
 * with `rm -rf`, and are what upstream CI checks out. Dependencies come from the checkout's
 * own pnpm lockfile (`--frozen-lockfile`); pnpm's content-addressed store makes a second
 * ref's install mostly clones/hardlinks.
 *
 * Every checkout is a detached HEAD at an exact commit. Its provenance is recorded in
 * <checkout>/.git/svelte-lite-vendor.json (inside .git so the worktree stays pristine),
 * and the active selection in svelte-ref.json at the project root:
 *   { repo, ref, tag, sha, version, path }
 * scripts/link-svelte.ts reads that (or SVELTE_REF / --svelte=<ref> / SVELTE_DIR).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

export const ROOT = resolve(import.meta.dir, '..');
export const VENDOR_ROOT = join(ROOT, 'vendor', 'svelte');
export const LOCK_FILE = join(ROOT, 'svelte-ref.json');
export const DEFAULT_REPO = 'https://github.com/sveltejs/svelte.git';
/** Per-checkout provenance, relative to the checkout root. */
export const MARKER = join('.git', 'svelte-lite-vendor.json');

/** svelte-ref.json */
export interface SvelteLock {
	repo: string;
	/** the selected ref, normalized: '5.57.1', 'main', a sha, ... */
	ref: string;
	/** upstream tag, when the ref is one ('svelte@5.57.1'), else null */
	tag: string | null;
	sha: string;
	/** packages/svelte/package.json version at that commit */
	version: string;
	/** checkout (monorepo root), relative to the project root */
	path: string;
}

export interface VendorMarker extends Omit<SvelteLock, 'path'> {
	kind: 'tag' | 'branch' | 'commit';
	fetchedAt: string;
	install?: { lockfileHash: string; pnpm: string; at: string };
}

export interface ParsedRef {
	ref: string;
	kind: 'tag' | 'branch' | 'commit' | 'name';
	tag: string | null;
	slug: string;
}

/** Normalize a user-supplied ref. `name` = branch or tag, decided against the remote. */
export function parseRef(input: string): ParsedRef {
	const s = input.trim();
	if (/^[0-9a-f]{40}$/i.test(s)) {
		const sha = s.toLowerCase();
		return { ref: sha, kind: 'commit', tag: null, slug: `commit-${sha.slice(0, 12)}` };
	}
	if (/^[0-9a-f]{7,39}$/i.test(s) && /\d/.test(s) && /[a-f]/i.test(s)) {
		throw new Error(`"${s}" looks like an abbreviated commit sha; pass all 40 characters (a shallow fetch needs the full sha)`);
	}
	const v = s.match(/^(?:svelte@)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
	if (v) return { ref: v[1], kind: 'tag', tag: `svelte@${v[1]}`, slug: v[1] };
	if (!/^[\w.@/-]+$/.test(s) || s.includes('..') || s.startsWith('-') || s.startsWith('/')) {
		throw new Error(`invalid ref "${s}"`);
	}
	return { ref: s, kind: s === 'main' ? 'branch' : 'name', tag: null, slug: s.replace(/[/@]/g, '-') };
}

const normRepo = (r: string) => r.replace(/\/+$/, '').replace(/\.git$/, '');
/** URLs pass through; local paths become file:// URLs so that `--depth` is honoured. */
export const repoUrl = (repo: string) => (/^[\w+-]+:\/\//.test(repo) || /^[^/]+@[^:]+:/.test(repo) ? repo : `file://${resolve(repo)}`);
export const isDefaultRepo = (repo: string) => normRepo(repo) === normRepo(DEFAULT_REPO);

/** Directory name for a ref from a repo: `<slug>` for upstream, `<slug>--<owner>-<name>` otherwise. */
export function slugFor(parsed: ParsedRef, repo: string) {
	if (isDefaultRepo(repo)) return parsed.slug;
	const id = normRepo(repo)
		.replace(/^[a-z+]+:\/\//i, '')
		.replace(/^[^@/]+@/, '')
		.split(/[/:]/)
		.filter(Boolean)
		.slice(-2)
		.join('-')
		.replace(/[^\w.-]/g, '-');
	return `${parsed.slug}--${id}`;
}

export function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}
export const readLock = () => readJson<SvelteLock>(LOCK_FILE);
export const readMarker = (checkout: string) => readJson<VendorMarker>(join(checkout, MARKER));

/** HEAD sha of a checkout without spawning git when HEAD is detached (always true for vendored refs). */
export function headSha(repoDir: string): string | null {
	try {
		const head = readFileSync(join(repoDir, '.git', 'HEAD'), 'utf8').trim();
		if (/^[0-9a-f]{40}$/.test(head)) return head;
	} catch {}
	const r = Bun.spawnSync(['git', '--no-optional-locks', '-C', repoDir, 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
	return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

// ---------------------------------------------------------------------------------------------

function git(cwd: string, args: string[], { allowFail = false } = {}) {
	const r = Bun.spawnSync(['git', '-c', 'advice.detachedHead=false', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
	});
	const out = r.stdout.toString().trim();
	const err = r.stderr.toString().trim();
	if (r.exitCode !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed in ${cwd}${err ? `:\n${err}` : ''}`);
	return { ok: r.exitCode === 0, out, err };
}

const rel = (p: string) => relative(ROOT, p) || '.';
const secs = (t0: number) => `${((performance.now() - t0) / 1000).toFixed(1)} s`;

function findPnpm(): string {
	if (process.env.PNPM) return process.env.PNPM;
	const onPath = Bun.which('pnpm');
	if (onPath) return onPath;
	const nvm = join(homedir(), '.nvm', 'versions', 'node');
	if (existsSync(nvm)) {
		const semver = (v: string) => v.replace(/^v/, '').split('.').map(Number);
		const versions = readdirSync(nvm).sort((a, b) => {
			const [x, y] = [semver(a), semver(b)];
			return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
		});
		for (const v of versions) if (existsSync(join(nvm, v, 'bin', 'pnpm'))) return join(nvm, v, 'bin', 'pnpm');
	}
	throw new Error('pnpm not found: install it (`corepack enable` or `npm i -g pnpm`) or set PNPM=/path/to/pnpm');
}

/** Env for pnpm: its own bin dir (where `node` lives for nvm installs) first on PATH. */
const pnpmEnv = (pnpm: string) => ({ ...process.env, PATH: `${dirname(pnpm)}:${process.env.PATH ?? ''}` });

function pnpmVersion(pnpm: string) {
	const r = Bun.spawnSync([pnpm, '--version'], { stdout: 'pipe', stderr: 'pipe', env: pnpmEnv(pnpm) });
	return r.exitCode === 0 ? r.stdout.toString().trim() : '?';
}

function install(checkout: string, marker: VendorMarker, force: boolean) {
	const lockfile = join(checkout, 'pnpm-lock.yaml');
	if (!existsSync(lockfile)) throw new Error(`${rel(checkout)} has no pnpm-lock.yaml; is this the Svelte monorepo?`);
	const lockfileHash = Bun.hash(readFileSync(lockfile)).toString(16);
	const installed = marker.install?.lockfileHash === lockfileHash && existsSync(join(checkout, 'node_modules', '.modules.yaml'));
	if (installed && !force) {
		console.log(`dependencies up to date (pnpm-lock.yaml unchanged since ${marker.install!.at})`);
		return;
	}
	const pnpm = findPnpm();
	const have = pnpmVersion(pnpm);
	const pm: string | undefined = readJson<any>(join(checkout, 'package.json'))?.packageManager;
	const want = pm?.match(/^pnpm@([^+]+)/)?.[1];
	if (!pm) console.warn(`warning: ${rel(checkout)}/package.json has no packageManager field; using pnpm ${have}`);
	else if (!want) console.warn(`warning: packageManager is "${pm}", not pnpm; installing with pnpm ${have} anyway`);
	else if (want !== have) {
		console.warn(
			`warning: the checkout wants pnpm ${want} (packageManager), found pnpm ${have} at ${pnpm}.\n` +
				`         pnpm may switch versions itself (manage-package-manager-versions) or lay out node_modules differently.`
		);
	}
	console.log(`pnpm ${have}: install --frozen-lockfile in ${rel(checkout)}`);
	const t0 = performance.now();
	const r = Bun.spawnSync([pnpm, 'install', '--frozen-lockfile', '--config.confirm-modules-purge=false'], {
		cwd: checkout,
		stdout: 'inherit',
		stderr: 'inherit',
		env: pnpmEnv(pnpm)
	});
	if (r.exitCode !== 0) throw new Error(`pnpm install --frozen-lockfile failed in ${rel(checkout)} (exit ${r.exitCode})`);
	console.log(`installed in ${secs(t0)}`);
	marker.install = { lockfileHash, pnpm: have, at: new Date().toISOString() };
}

function du(path: string, exclude?: string) {
	const r = Bun.spawnSync(['du', '-sk', ...(exclude ? ['-I', exclude] : []), path], { stdout: 'pipe', stderr: 'pipe' });
	const kb = Number(r.stdout.toString().split(/\s/)[0]);
	return Number.isFinite(kb) ? `${(kb / 1024).toFixed(0)} MB` : '?';
}

/** Which kind is a bare name on the remote: branch (preferred) or tag? */
function resolveName(repo: string, name: string): 'branch' | 'tag' {
	const r = git(ROOT, ['ls-remote', repo, `refs/heads/${name}`, `refs/tags/${name}`], { allowFail: true });
	if (!r.ok) throw new Error(`cannot reach ${repo}:\n${r.err}`);
	if (r.out.includes(`\trefs/heads/${name}`)) return 'branch';
	if (r.out.includes(`\trefs/tags/${name}`)) return 'tag';
	throw new Error(`"${name}" is neither a branch nor a tag of ${repo}`);
}

/** The newest release tags of the same major (svelte@5.*), for a helpful "not found" error. */
function suggestTags(repo: string, tag: string) {
	const prefix = tag.replace(/^(svelte@\d+\.).*$/, '$1');
	const r = git(ROOT, ['ls-remote', '--tags', '--refs', repo, `refs/tags/${prefix}*`], { allowFail: true });
	const num = (t: string) => t.slice(prefix.length).split(/[.-]/).map((x) => Number(x) || 0);
	const tags = r.out
		.split('\n')
		.map((l) => l.split('refs/tags/')[1])
		.filter((t) => t && /^svelte@\d+\.\d+\.\d+$/.test(t))
		.sort((a, b) => {
			const [x, y] = [num(a), num(b)];
			return y[0] - x[0] || y[1] - x[1];
		})
		.slice(0, 6);
	return tags.length ? ` Newest ${prefix}* releases: ${tags.join(', ')}` : '';
}

export interface VendorOptions {
	repo?: string;
	update?: boolean;
	install?: boolean;
	reinstall?: boolean;
	force?: boolean;
	/** sha to check out instead of the ref's tip (lockfile re-creation) */
	pin?: string | null;
}

/** Fetch/check out one ref (shallow) and install its dependencies. Returns the checkout's provenance. */
export function vendor(input: string, opts: VendorOptions = {}): { checkout: string; marker: VendorMarker } {
	const repo = repoUrl(opts.repo ?? DEFAULT_REPO);
	const parsed = parseRef(input);
	const checkout = join(VENDOR_ROOT, slugFor(parsed, repo));
	const existing = existsSync(join(checkout, '.git'));
	let marker = existing ? readMarker(checkout) : null;
	if (marker && normRepo(marker.repo) !== normRepo(repo)) {
		throw new Error(`${rel(checkout)} was vendored from ${marker.repo}, not ${repo}; remove it first`);
	}

	const kind: VendorMarker['kind'] = parsed.kind === 'name' ? (marker?.kind ?? resolveName(repo, parsed.ref)) : parsed.kind;
	const tag = kind === 'tag' ? (parsed.tag ?? parsed.ref) : null;
	const t0 = performance.now();

	if (!existing) {
		mkdirSync(checkout, { recursive: true });
		git(checkout, ['init', '-q']);
		git(checkout, ['remote', 'add', 'origin', repo]);
	}

	// fetch when new, incomplete, --update, or the checkout must move to the svelte-ref.json pin
	if (!existing || !marker || opts.update || (opts.pin && opts.pin !== marker.sha)) {
		console.log(`fetching ${tag ?? parsed.ref} from ${repo} (shallow) into ${rel(checkout)}`);
		let target: string;
		const fetch = (refspec: string) => git(checkout, ['fetch', '--depth', '1', '--no-tags', '--quiet', 'origin', refspec], { allowFail: true });
		if (kind === 'tag') {
			const f = fetch(`+refs/tags/${tag}:refs/tags/${tag}`);
			if (!f.ok) {
				if (!existing) rmSync(checkout, { recursive: true, force: true });
				throw new Error(`tag ${tag} not found in ${repo}.${suggestTags(repo, tag!)}\n${f.err}`);
			}
			target = `refs/tags/${tag}^{commit}`;
		} else if (kind === 'branch') {
			const f = fetch(`+refs/heads/${parsed.ref}:refs/remotes/origin/${parsed.ref}`);
			if (!f.ok) {
				if (!existing) rmSync(checkout, { recursive: true, force: true });
				throw new Error(`branch ${parsed.ref} not found in ${repo}\n${f.err}`);
			}
			target = `refs/remotes/origin/${parsed.ref}`;
		} else {
			target = parsed.ref;
		}
		if (opts.pin || kind === 'commit') {
			const sha = opts.pin ?? parsed.ref;
			if (kind === 'tag' && git(checkout, ['rev-parse', target]).out !== sha) {
				throw new Error(`tag ${tag} now points at ${git(checkout, ['rev-parse', target]).out} upstream, but svelte-ref.json pins ${sha}. The tag moved; re-vendor deliberately with \`bun run vendor ${parsed.ref} --update\`.`);
			}
			if (kind !== 'tag' && git(checkout, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }).ok === false) {
				const f = fetch(sha);
				if (!f.ok) {
					if (!existing) rmSync(checkout, { recursive: true, force: true });
					throw new Error(`commit ${sha} not found in ${repo}\n${f.err}`);
				}
			}
			target = sha;
		}
		const sha = git(checkout, ['rev-parse', `${target}^{commit}`]).out;
		const head = existing ? headSha(checkout) : null;
		if (head !== sha) {
			if (existing) {
				const dirty = git(checkout, ['status', '--porcelain']).out;
				if (dirty && !opts.force) {
					throw new Error(`${rel(checkout)} has local changes; refusing to move it to ${sha.slice(0, 12)} (use --force to discard them):\n${dirty}`);
				}
			}
			git(checkout, ['checkout', '--quiet', '--detach', ...(opts.force ? ['--force'] : []), sha]);
			if (head) console.log(`moved ${rel(checkout)}: ${head.slice(0, 12)} -> ${sha.slice(0, 12)}`);
		} else if (existing) {
			console.log(`${rel(checkout)} already at ${sha.slice(0, 12)} (up to date)`);
		}
		const version = readJson<any>(join(checkout, 'packages', 'svelte', 'package.json'))?.version;
		if (!version) throw new Error(`${rel(checkout)} has no packages/svelte/package.json; is ${repo} the Svelte monorepo?`);
		marker = { repo, ref: parsed.ref, kind, tag, sha, version, fetchedAt: new Date().toISOString(), install: marker?.install };
		writeFileSync(join(checkout, MARKER), JSON.stringify(marker, null, '\t') + '\n');
		console.log(`checked out ${kind === 'commit' ? sha : `${tag ?? parsed.ref} = ${sha}`} (svelte ${version}) in ${secs(t0)}`);
	} else {
		const head = headSha(checkout);
		if (head !== marker.sha) {
			throw new Error(`${rel(checkout)} is at ${head} but was vendored at ${marker.sha}; re-run with --update (or --force to reset)`);
		}
		const age = kind === 'branch' ? ` (fetched ${marker.fetchedAt}; --update fetches the latest ${parsed.ref})` : '';
		console.log(`${rel(checkout)}: already vendored at ${marker.sha.slice(0, 12)} (svelte ${marker.version})${age}`);
	}

	if (opts.install !== false) {
		install(checkout, marker, !!opts.reinstall);
		writeFileSync(join(checkout, MARKER), JSON.stringify(marker, null, '\t') + '\n');
	}
	return { checkout, marker };
}

/** Make a vendored checkout the active Svelte: write svelte-ref.json and re-point node_modules/svelte. */
export function activate(checkout: string, marker: VendorMarker) {
	const lock: SvelteLock = {
		repo: marker.repo,
		ref: marker.ref,
		tag: marker.tag,
		sha: marker.sha,
		version: marker.version,
		path: relative(ROOT, checkout)
	};
	writeFileSync(LOCK_FILE, JSON.stringify(lock, null, '\t') + '\n');
	console.log(`active: ${rel(LOCK_FILE)} -> ${lock.tag ?? lock.ref} @ ${lock.sha.slice(0, 12)} (svelte ${lock.version})`);
	// fresh process: link-svelte.ts resolves at import time, and must see the new lock, not our env overrides
	const env: Record<string, string | undefined> = { ...process.env };
	delete env.SVELTE_REF;
	delete env.SVELTE_DIR;
	const r = Bun.spawnSync(['bun', join(ROOT, 'scripts', 'link-svelte.ts')], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit', env });
	if (r.exitCode !== 0) throw new Error('re-linking node_modules/svelte failed');
}

function list() {
	const lock = readLock();
	const dirs = existsSync(VENDOR_ROOT) ? readdirSync(VENDOR_ROOT).filter((d) => statSync(join(VENDOR_ROOT, d)).isDirectory()) : [];
	if (!dirs.length) console.log('nothing vendored yet: bun run vendor 5.57.1');
	for (const d of dirs.sort()) {
		const dir = join(VENDOR_ROOT, d);
		const m = readMarker(dir);
		const active = lock && resolve(ROOT, lock.path) === dir ? '*' : ' ';
		if (!m) {
			console.log(`${active} ${d.padEnd(22)} (incomplete: re-run bun run vendor ${d})`);
			continue;
		}
		const head = headSha(dir);
		const moved = head !== m.sha ? `  !! HEAD moved to ${head?.slice(0, 12)}` : '';
		const installed = m.install ? `installed ${m.install.at.slice(0, 10)}` : 'NOT INSTALLED';
		console.log(`${active} ${d.padEnd(22)} ${(m.tag ?? m.ref).padEnd(18)} ${m.sha.slice(0, 12)}  svelte ${m.version.padEnd(10)} fetched ${m.fetchedAt.slice(0, 16)}  ${installed}  ${m.repo}${moved}`);
	}
	if (lock) console.log(`\nsvelte-ref.json: ${lock.tag ?? lock.ref} @ ${lock.sha} (${lock.path})`);
}

const USAGE = `usage: bun run vendor <ref> [--repo=<url|path>] [--update] [--no-activate] [--no-install] [--reinstall] [--force]
       bun run vendor              re-create the checkout pinned in svelte-ref.json
       bun run vendor --list
  <ref>: main | 5.57.1 | svelte@5.57.1 | <40-char sha> | another branch/tag name`;

if (import.meta.main) {
	const args = process.argv.slice(2);
	const flag = (name: string) => args.includes(`--${name}`);
	const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
	const known = /^--(repo=.*|update|no-activate|no-install|reinstall|force|list|help)$/;
	const bad = args.filter((a) => a.startsWith('-') && !known.test(a));
	const refs = args.filter((a) => !a.startsWith('-'));
	if (bad.length || refs.length > 1 || flag('help')) {
		if (bad.length) console.error(`unknown option(s): ${bad.join(' ')}`);
		console.error(USAGE);
		process.exit(flag('help') ? 0 : 1);
	}
	if (flag('list')) {
		list();
		process.exit(0);
	}
	try {
		const lock = readLock();
		let input = refs[0];
		let repo = value('repo');
		let pin: string | null = null;
		if (!input) {
			if (!lock) throw new Error('usage: bun run vendor <ref>   (e.g. 5.57.1, svelte@5.57.1, main); no svelte-ref.json to re-create');
			// `bun run vendor` = re-create exactly what svelte-ref.json pins (like `npm ci`)
			input = lock.ref;
			repo ??= lock.repo;
		}
		repo ??= DEFAULT_REPO;
		const parsed = parseRef(input);
		// the lock's own ref, checked out from scratch: honour its pinned sha (reproducible), unless --update
		const lockDir = lock ? resolve(ROOT, lock.path) : null;
		const target = join(VENDOR_ROOT, slugFor(parsed, repoUrl(repo)));
		if (lock && lockDir === target && !flag('update')) pin = lock.sha;

		const t0 = performance.now();
		const { checkout, marker } = vendor(input, {
			repo,
			pin,
			update: flag('update'),
			install: !flag('no-install'),
			reinstall: flag('reinstall'),
			force: flag('force')
		});
		console.log(`\n${rel(checkout)}: ${marker.tag ?? marker.ref} @ ${marker.sha} (svelte ${marker.version}), total ${secs(t0)}`);
		console.log(`disk: checkout ${du(checkout, 'node_modules')} + node_modules ${du(join(checkout, 'node_modules'))} (pnpm clones/hardlinks from its store; du counts them in full)`);
		if (!flag('no-activate')) activate(checkout, marker);
		else if (lock && resolve(ROOT, lock.path) === checkout && lock.sha !== marker.sha) {
			console.warn(
				`warning: svelte-ref.json still pins ${lock.sha.slice(0, 12)}, so builds refuse to run: \`bun run vendor ${marker.ref} --update\` ` +
					`pins this commit, \`bun run vendor\` goes back to the pinned one`
			);
		}
	} catch (e: any) {
		console.error(`vendor: ${e?.message ?? e}`);
		process.exit(1);
	}
}
