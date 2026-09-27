# svelte-lite

A slimmed-down build of the Svelte 5 client runtime, made with `Bun.build()` (Bun 1.4.2). The official Svelte source is vendored and **never forked or edited**. Every change is a documented patch applied in memory at build time.

The target usage is **SSR + `hydrate()` only**: every test app is rendered on the server and then hydrated. `mount()` isn't a goal.

## Ground rules

- **Never edit Svelte source.** That covers `vendor/svelte/*` and any `SVELTE_DIR` checkout such as `../svelte`. All changes go in `patches/*.ts`, which `plugins/patch.ts` applies during the build. The build refuses to run if the checkout's `packages/svelte` has local changes.
- **Patches fail loudly. Keep it that way.**
  - Every text edit checks how many times its anchor matches.
  - Every whole-function or whole-block replacement is pinned to a hash of the *upstream* code.
  - When a pin breaks on a new Svelte ref, review the upstream change and then update the pin. Never loosen an anchor just to make a build pass.
- **Keep patches minimal and give each one a `feature` and a `why`.** `PATCHES.md` is generated from the patch definitions (`bun run patches`); don't hand-edit its generated sections.
- **`optimized` must stay lossless.** It must show zero new failures in `bun run test:svelte optimized`, with async mode both on and off. Anything that loses a feature belongs in `minimal`.
- **A dropped feature must fail clearly.**
  - Prefer a build-time error from `plugins/svelte.ts`, which scans compiled output. For example, `transition:` or `$effect.pending()` under `minimal` is a build error.
  - Otherwise use a runtime stub that throws `svelte-lite: <thing> is not supported in this build`.
  - Never fail silently.
- **Dev-only code must disappear from production bundles.** When a patch touches `if (DEV)` code, confirm `main.min.js` is byte-identical before and after. Example: the `flatten()` replacement in `patches/minimal.ts` keeps upstream's `$inspect.trace` labelling block as a self-contained `if (DEV) { const …; return; }`, because a shared `var` cost 8 B in production.

## Commands

```sh
bun install                          # postinstall links node_modules/svelte to the active vendored ref
bun run vendor 5.57.1                # vendor + activate a ref: main | 5.57.1 | svelte@5.57.1 | <sha>
bun run vendor --list                # what's vendored (* = active)
bun run anchors [--svelte=<ref>]     # do all patch anchors apply to that ref? (no build)

bun run build.ts <variant> [--app=reactive] [--no-coverage] [--svelte=<ref>] [--out=<dir>]
bun run build.ts minimal --strict-hydration --short-errors   # build flags -> dist/minimal+strict-hydration+short-errors/
bun run build.ts --all               # every variant x app; about 15 min (coverage and compression dominate)
bun run build-vite.ts <variant> [--all] [--app=x] [--svelte=<ref>]   # same variants bundled by Vite -> dist-vite/
bun run check.ts [variant]           # happy-dom check + patch anchors + negative tests
bun run test:svelte <variant> [--suite=runtime-runes] [--filter=<sample>] [--without=PROXY] [--async=on|off] [--fresh]
bun run compare                      # size table: baseline vs optimized vs minimal
bun run coverage:bytes [variant] [--app=x]   # V8 block coverage -> COVERAGE.md (needs Node >= 26 on PATH)

bun run patches                      # regenerate PATCHES.md
bun run comparison                   # regenerate COMPARISON.md (needs coverage.json: build without --no-coverage)
bun run comparison:vite              # regenerate VITE.md: Bun (dist/) vs Vite (dist-vite/), same Svelte ref on both sides
bun run test:svelte --report         # regenerate SVELTE_TESTS.md from saved results
```

**Variants** (`variants.ts`):

| Variant | What it is |
|---|---|
| `baseline` | Vanilla Svelte |
| `optimized` | Lossless Bun fixes only |
| `minimal` | `optimized` plus: no legacy mode, no async, no transitions/animations, no root boundary in `_mount`, lazy event delegation, `proxy()` only when used |
| `m1-legacy` … `m5-delegation` | Cumulative steps between `optimized` and `minimal`, for the stacking table |
| `baseline-bun` | `optimized` plus the post-pass's minify steps (`MINIFY`): Bun's closest lossless match to Vite's baseline (VITE.md). Not in the stack; `optimized`/`minimal` don't use these steps yet |

**Build flags** (`patches/flags.ts`, `BUILD_FLAGS` in `variants.ts`) are opt-in techniques you can stack on any variant. A flagged build is its own variant, `<variant>+<flag>…`: it goes to `dist/<variant>+<flag>…/`, and names like `minimal+strict-hydration` also work in `check.ts` and `test:svelte`.

| Flag | What it does |
|---|---|
| `--strict-hydration` | A hydration mismatch throws `hydration_failed` instead of clearing the target and re-rendering on the client. It's like `hydrate(…, { recover: false })`, except the recovery code no longer ships. The `hydration_mismatch` warning stays. `harness.ts` expects the throw for these variants |
| `--short-errors` | Every production error/warning function calls one shared helper with just its code. The message text is unchanged; stacks gain one frame. This saves raw and brotli bytes, but gzip was already compressing the repeated URL prefix (see Known state) |

**Apps** (`apps/`):

| App | What it covers |
|---|---|
| `hello` | Compiles to static HTML: the compiler inlines a `$state` that is never reassigned |
| `reactive` | The realistic case |
| `boundary` | Error boundaries |
| `stores` | Stores and `$effect.pre` writes during a flush |

## Layout

| Path | What it is |
|---|---|
| `build.ts`, `variants.ts` | Build driver; variants are composed from techniques |
| `build-vite.ts`, `plugins/vite.ts` | The same variants bundled by Vite 8 (Rolldown + Oxc). The Vite plugins call the same `loadPatched()` and `compileSvelte()` as the Bun plugins, so only the bundler differs. `optimizeImports` and `postpass` are Bun-only and skipped |
| `patches/optimized.ts`, `patches/minimal.ts`, `patches/flags.ts` | Patch definitions, grouped by technique (`LEGACY`, `ASYNC`, `TRANSITIONS`, `ROOT_BOUNDARY`, `DELEGATION`, `PROXY`, …; build flags `STRICT_HYDRATION`, `SHORT_ERRORS`) |
| `plugins/patch.ts` | Patch engine: `replace`, `removeMembers`, `removeFunctions`, `replaceFunctions`, `prepend`, `contents`, `constImports` |
| `plugins/svelte.ts` | `.svelte` compile plugin, named imports, build-time bans |
| `plugins/transform-compiled.js` | Compiled-output rewrite `$.set(x, v, true)` → `$.set(x, $.proxy(v))`; shared by the build and the test helper |
| `postpass.ts` | Removes dead code Bun leaves in the output: unreferenced `#private` class members, constant-false branches and statements after `return`/`throw`. It repeats until nothing changes, then re-bundles |
| `postpass-minify.ts` | Opt-in post-pass steps (`postpass: { constants, flagTests, sequenceTests }`) for minifier work Bun lacks and Oxc does: never-written literal bindings inlined, `(f & N) !== 0` → `f & N`, `if (a, !1)` folded. Each round ends in a syntax-only re-bundle so Bun folds what they expose |
| `scripts/link-svelte.ts` | **The single source of truth** for Svelte's location: `SVELTE_DIR`, `SVELTE_REPO`, `SVELTE_INFO`. Never hard-code `../svelte` |
| `scripts/vendor-svelte.ts` | Vendoring into `vendor/svelte/<ref>/` (one shallow clone per ref, pnpm install from the checkout's own lockfile) |
| `harness.ts` | The behavioural test harness (SSR HTML → `hydrate()` → `apps/<app>/test.ts` in happy-dom). Runtime-neutral (`node:` APIs only), so Bun (`check.ts`) and Node run the same thing |
| `scripts/byte-coverage.ts`, `scripts/v8-coverage.ts` | Byte-level coverage: runs the harness under Node with V8 block coverage, attributes never-executed bytes of `main.min.js` to functions, scans for provably dead code, writes `COVERAGE.md` and `dist/<variant>/<app>/coverage.readable.txt` (per-line gutter). `scripts/coverage.ts` is the older function-level view, which overstates usage |
| `scripts/svelte-tests.ts` | Runs Svelte's official Vitest suites on disposable patched copies in `.cache/svelte-test/` and diffs against unpatched Svelte |
| `dist/<variant>/<app>/` | Build output. `main.min.js` is the measured number; read `main.readable.js` (same dead-code elimination, readable names, module markers) |
| `dist-vite/<variant>/<app>/` | The same layout from `build-vite.ts`. `check.ts --out=dist-vite` re-checks it |

**Docs:**

| File | What it covers |
|---|---|
| `FEATURE_REPORT.md` | Feature and LOC map of the runtime. Its byte figures are from Rollup/esbuild; see its Bun addendum |
| `BASELINE.md` | Bun options and baseline analysis |
| `COMPARISON.md` | Sizes and stacking table |
| `VITE.md` | Bun vs Vite on the same variants: sizes, stacking, per-module differences. Generated, except the hand-written setup above the marker |
| `PATCHES.md` | Every patch, generated |
| `SVELTE_TESTS.md` | Results of Svelte's own test suite |
| `COVERAGE.md` | How much of each shipped bundle executes, and the provably dead bytes. Generated, except the hand-written notes block |

## Svelte source selection

The ref is resolved in this order, highest first:

1. `--svelte=<ref>`
2. `SVELTE_DIR=<path>` (escape hatch, e.g. `../svelte`)
3. `SVELTE_REF=<ref>`
4. `svelte-ref.json`

Reports stamp the ref and sha into `report.json`, `COMPARISON.md` and `PATCHES.md`.

`--svelte=` sets `process.env.SVELTE_REF`. `Bun.spawn` children only see it when spawned with `env: process.env`.

## After changing a patch

1. `bun run anchors`, against every ref you care about.
2. `bun run build.ts <variant> --no-coverage` to build and run the behaviour check. Compare `main.min.js` sizes, and diff `main.readable.js` to see what actually changed.
3. `bun run test:svelte optimized` and/or `bun run test:svelte minimal`. The pass condition is **0 unexpected regressions**, which takes about 1–3 minutes once the reference results are cached. For `optimized`, also run with `--async=off`.
4. Regenerate the docs: `bun run patches`, `bun run comparison`.

The test helper leaves out `DEV_CONST` by default, because most suites run the dev runtime. So every other patch is also tested under `DEV = true`, and a patch that breaks only in dev *is* a real bug. Deliberately breaking a patch should produce regressions; if it doesn't, the suite doesn't cover it.

## Bun 1.4.2 dead-code elimination: what we learned

Most of the work here exists because Bun eliminates much less dead code than Rollup. The same Hello World is 41.5 KB with Bun and 23.7 KB with Rollup.

- **Silent dev builds.** Without `define: { 'process.env.NODE_ENV': '"production"' }`, Bun adds the `development` condition, which overrides `conditions: ['production']`, so esm-env's `DEV` becomes a runtime check. `build.ts` fails the build if this goes wrong.
- **Constants aren't carried across modules.** `import { DEV } from 'esm-env'` never folds; the `constImports` rule turns it into a local `const`.
- **Folding rules are narrow:**
  - A module-level `const` only folds if it comes before every import and statement, and never in a module that has `export { x } from '…'`.
  - A function-local `const` only folds if it is the first statement in the function body; after a `var` it silently turns into a `let`.
  - A `let` never folds, which is why the flags `hydrating`, `legacy_mode_flag` and `async_mode_flag` need patches.
  - A binding that is never written isn't treated as a constant either: `async_mode_flag` stays a variable even when its setter is tree-shaken. Oxc and Terser inline these. `postpass-minify.ts` does it for `baseline-bun`, but only for bindings no earlier-running code can reach, because Bun emits module-level `const` as `var`.
- **Bun keeps dead code in two more cases:**
  - a constant-false block that declares a `var`. `if (!1) { var x; for (…) … }` is kept whole, loops and conditions included, although only the hoisted `var` names need to survive.
  - statements after a `return` or `throw`. This happens, for example, once a flag const turns a guard into an unconditional `return`, as in `Batch.apply()` when `async_mode_flag` is false.
  
  `postpass.ts` removes both kinds (variants with `postpass: true`). `bun run coverage:bytes` reports any that remain, which should be 0 B.
- **Bun never removes class members,** not even unreferenced `#private` ones. Use `removeMembers` or `postpass.ts`.
- **Other dead code Bun keeps:**
  - unused nested functions;
  - calls to empty functions;
  - `Symbol()` calls, array spreads and global property reads, which it treats as side effects;
  - single-use `var`s, which it doesn't inline.
  
  Use `/*@__PURE__*/` annotations or restructure the code.
- **Top-level side effects pull in whole modules.** `custom-element.js` dragged in `svelte/legacy` and `hydrate()`. The fix is named imports from compiled components plus `optimizeImports: ['svelte']`.
- **gzip already removes repeated strings.** Replacing a repeated prefix, e.g. the `https://svelte.dev/e/` in 61 messages, with a shared helper saves raw bytes but almost no gzip. Only removing *unique* content saves gzip. Always compare gzip, not just raw.
- **Bun's minifier keeps statements as statements.** Unlike Oxc, it doesn't turn `if (a) b()` into `a && b()`, `if/else` into `?:`, or inline single-use locals. With the same input, Oxc is about 1 KB smaller on `hello`. Doing the `if` rewrites in a post-pass cut 1.5% raw but *added* 42–67 B gzip per app, because `if(` compresses better, so `baseline-bun` leaves them out (VITE.md).
- **Minified names can shift** when eliminated code changes, giving the same raw bytes but a gzip size a few bytes different. Judge changes by raw size and a diff of `main.readable.js`, not gzip alone.
- **Build-option limits:**
  - `feature()` from `bun:bundle` only works directly in an `if` or ternary.
  - There's no way to inject `sideEffects: false`.
  - Metafile paths resolve relative to `outdir`.
- **Docs:** use `https://bun.sh/docs/<page>.md`. The `.md` links in `bun.sh/llms.txt` return 404 on bun.com.

## Pitfalls

- **Don't build against two Svelte refs at once in this directory.** Builds re-point the shared `node_modules/svelte` symlink and would race; use `--out` plus an isolated copy of the project instead. This includes `build-vite.ts` next to a running `build.ts`: give both the same `SVELTE_REF`/`--svelte=`.
- **Never run Vitest inside `vendor/svelte/<ref>`.** It writes `_actual*` files that aren't gitignored, and then the dirty-checkout guard blocks every build. Use `bun run test:svelte`.
- **Read the stacking table with care.** Savings in `COMPARISON.md` depend on step order: a step gets credit for everything that becomes unreachable when it lands. For example, the async step removes `set()` and `proxy()` from `hello`.
- **When iterating,** pass `--no-coverage` and a single variant or `--app=`. Do a full build before regenerating `COMPARISON.md`.

## Known state (2026-09-27)

- The reference numbers came from upstream `main` at `f90853565966`, and vendored `main` reproduces them byte for byte.
- **`svelte-ref.json` points at `svelte@5.57.1`, where `minimal` (and m2 through m5) fails.** The pinned `fork()` replacement hash in the `ASYNC` patch only matches `main`'s `fork()`. `baseline` and `optimized` build fine there. Until this is resolved, build `minimal` with `--svelte=main`. Whether to accept both hashes and re-pin to the tag, or to pin the `main` sha, is still an open decision for the user.
- Every `dist/` report was rebuilt from vendored `main` (`SVELTE_REF=main bun run build.ts --all`, plus the flagged `minimal` builds).
- **Build flag results** (`COMPARISON.md`):
  - `--strict-hydration` pays: −210 to −250 B min / −85 to −105 B gzip. Only Svelte's five recovery tests fail, and they are classified as expected.
  - `--short-errors` saves raw bytes but gzip grows 4–18 B. Numeric error codes would save about 70 B gzip on `reactive`, but messages would become opaque numbers. That hasn't been adopted.
- **Test coverage gaps for `minimal`:**
  - Most hydration and runtime-browser samples use legacy components, so only 19 hydration and 26 browser tests exercise `minimal`.
  - Only 15 tests exercise the proxy rewrite.
  - The `legacy_updates` and `#merge` removals are only covered indirectly.
- **Cosmetic:** in post-passed builds, `main.readable.js` keeps a `// dist/…/.postpass-input.js` header line.
