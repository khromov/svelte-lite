# SVELTE_TESTS: Svelte's own test suite against the patched variants

`bun run test:svelte <variant>` runs Svelte's official Vitest suites against a variant's patched runtime and compares every test with unpatched Svelte (the reference). Tested at Svelte `f90853565966` (5.57.1).

## Result

|  | `optimized` | `minimal` |
| --- | --- | --- |
| **unexpected regressions** | **0** (async mode on and off) | **0** |
| runtime-runes | 2707 / 2707 pass (async on); 1826 / 1826 (async off) | 1766 / 1826: the other 60 use transitions (40), legacy components (18) or `transformError` (2) |
| runtime-legacy | 3303 / 3303 | 0 / 3301: all expected (legacy mode is dropped) |
| hydration | 84 / 84 | 19 / 84: the other 65 are legacy (non-runes) components, plus one `pending` boundary |
| runtime-browser (real Chromium, production runtime) | 102 / 102 | 26 / 102: the other 76 are legacy components |
| runtime-production, runtime-xhtml, store, motion | all pass | all pass |
| signals | all pass | all but 1 (enables async mode) |
| unit tests (`src/**/*.test.ts`) | all pass | all pass. 32 server-renderer tests are skipped because their hooks enable async mode. |

Tests that also fail on the unpatched reference are not counted as regressions. There are two: one runtime-legacy test, and in no-async mode the signals test `schedules rerun when writing to signal before reading it (runes mode)`.

- **`optimized` is lossless according to Svelte's own suite.** It passes all 6,500 tests in both async modes, with runtime-browser in a real Chromium, plus the production-runtime suites with `DEV_CONST` applied.
- **`minimal`: every failure is a dropped feature.** Each one hits one of svelte-lite's `… is not supported` stubs, or statically uses legacy/async/transitions/`transformError`. None of the risky restructurings produced a regression (`legacy_updates` batching, `#merge`/`#find_earlier_batch`, the root boundary, lazy delegation, the proxy rewrite).
- **The suite really exercises those patches.** Breaking each one on purpose produces hundreds of unexpected regressions (see *Harness self-check*). The exception is the proxy rewrite, which only 15 tests exercise: reassigning objects/arrays to `$state`, including class fields.

## Triage

Only one test was ever reported as UNEXPECTED, in the first `minimal` run. The `unit` row also had a harness blind spot, fixed since.

| # | test | cause | verdict |
| --- | --- | --- | --- |
| 1 | `signals :: effects do depend on state they own (runes mode)` | The test calls `enable_async_mode_flag()` itself, and the ASYNC patch makes that throw (`svelte-lite: experimental.async is not supported`). Static detection missed it because `signals` has no sample directory. | **(b)** inherent: the test uses async mode, which `minimal` drops. The classifier now also treats "hit a svelte-lite stub" as evidence, recorded as the reason. |
| 2 | 32 × `unit :: src/internal/server/{renderer,hydratable}.test.ts` (passed → skipped) | Their `beforeAll` calls `enable_async_mode_flag()`, which throws, so Vitest skips the tests. The first classifier only diffed passed → failed, so these went unnoticed; it now also counts passed → skipped. | **(b)** inherent (async). Also a harness artifact: these test the *server* runtime, which svelte-lite never patches (SSR uses stock Svelte). But `src/internal/flags/index.js` is shared by client and server, so a single copy can't give the server its async mode back. |

No regression fell into (a) (a fixable patch bug) or (c) (an inherent consequence of a restructuring).

**DEV-only finding from reviewing the patches (not caught by the suite).** The ASYNC patch replaces `flatten()` with a sync-only version, and that version drops upstream's `if (DEV) { deriveds.forEach((d, i) => (d.label = …)) }` block. In dev builds, the deriveds behind template expressions lose their readable labels (used by `$inspect.trace()` and dev tooling). No test asserts these labels, and production is unaffected.
- **Verdict:** (a).
- **Proposed fix:** keep that DEV block in the `flatten` replacement (+6 lines, re-pin the hash).
- **Status:** not applied in this phase, since the patches are frozen.

## How it works

- **Disposable copies.** The monorepo is copied with `rsync` into `.cache/svelte-test/reference-async-<mode>/` and `.cache/svelte-test/<variant>-async-<mode>/`, without `.git`, `node_modules` and `_output`.
  - Each copy's `node_modules` (root and `packages/svelte`) is a *real* directory whose entries link into the checkout's pnpm `node_modules`. The checkout's relative pnpm links are replicated verbatim, so `svelte -> ../packages/svelte` resolves into the copy.
  - Dot-entries (`.vite`, `.vite-temp`, `.cache`, …) are not linked, so Vite/Vitest caches live in the copy.
  - After each run, the helper fails if anything in the checkout (outside `.git` and the pnpm store) is newer than the run's start.
- **Patching.** The variant copy's client runtime (`packages/svelte/src`, minus `compiler/` and `server/`) is rewritten with the *same* patch definitions and `applyPatches()` as the build. The per-copy log is `svelte-lite-patches.log`.
- **DEV.** `DEV_CONST` is not applied by default. It hard-codes `DEV = false`, but most suites run the dev runtime: esm-env resolves `DEV = true` under Vitest, and `runtime-production` mocks it to `false` with `vi.mock('esm-env')`.
  - **Why.** Skipping it keeps each suite running in the mode it was written for. Every other patch is therefore tested under DEV (runtime-runes/legacy, hydration, signals…) as well as under production (runtime-production and runtime-browser, which bundles with the `production` condition).
  - **The shipped combination.** `--with-dev-const` applies `DEV_CONST` as shipped. That is meaningful for `runtime-production` and `runtime-browser` only, and both variants pass there.
- **Compiled-output transform.** The suite compiles components itself. For variants with `proxySet`, the copy's `src/compiler/index.js` gets a two-line hook that runs `plugins/transform-compiled.js` (the module the Bun plugin uses) on every client `compile()`/`compileModule()` result. This covers `_output/client/**` as well as runtime-browser's esbuild bundles.
  - Only the `$.set(x, v, true)` → `$.set(x, $.proxy(v))` rewrite is applied.
  - The build-time bans (transitions, `pending`, …) are not enforced. Tests using those features fail and are classified as expected.
- **Async mode.** The suite compiles runes tests with `experimental.async` unless `SVELTE_NO_ASYNC=true`; the official CI runs both.
  - `optimized` defaults to async on. `--async=off` is also reported above.
  - `minimal` drops async, so it can only be compared in no-async mode, and that is its default.
  - The reference is always run in the same mode as the variant.
- **Vitest.** The run uses the official, unmodified `vitest.config.js` and test files: `node node_modules/vitest/vitest.mjs run --reporter=json` from each copy's root. The reference and the variant run in parallel.
  - Reference results are cached per (Svelte sha from `scripts/link-svelte.ts`, async mode, suite, filter) in `.cache/svelte-test/reference-results/`. `--fresh` re-runs them.
  - Uncommitted changes to `packages/svelte` are hashed into the key.
- **Classification.** A test that passes on the reference but fails, or is skipped, on the variant is **expected** when it uses a feature the variant drops. The evidence comes from the sample's `.svelte`/`.js`/`_config.js` sources and the reference's compiled `_output/client`:
  - **legacy:** the runtime-legacy suite; compiled output importing `svelte/internal/flags/legacy`; `runes: false`; `svelte/legacy` APIs.
  - **async:** `svelte/internal/flags/async`; `$.async`/`$.save`/`$.pending`/…; `experimental.async`; `$effect.pending`; `fork`/`settled`; `<svelte:boundary>` with `pending`; `hydratable`.
  - **transitions:** `$.transition`/`$.animation`; `outro: true`; `intro: true`.
  - **root boundary:** the `transformError` option.
  - **stub or hook:** the failure message is one of svelte-lite's `… is not supported` stubs, or a skipped test's file enables async/legacy mode in a hook.

  Everything else is **UNEXPECTED**, and the command exits 1.
- **runtime-browser** runs when the checkout's Playwright can launch Chromium, otherwise it is skipped with a message. `server-side-rendering`, compiler, parser, CSS, validator, migrate, print, sourcemap and snapshot suites are not run, since the compiler and server runtime are unpatched.

```sh
bun run test:svelte optimized                  # 10 suites, async on (default for optimized)
bun run test:svelte optimized --async=off
bun run test:svelte minimal                    # async off (default for minimal)
bun run test:svelte minimal --suite=runtime-runes,hydration --filter=/each/
bun run test:svelte minimal --without=PROXY,DELEGATION   # bisect: skip techniques
bun run test:svelte minimal --with-dev-const --suite=runtime-production,runtime-browser
bun run test:svelte minimal --mutate=no-hydrate-next     # harness self-check
bun run test:svelte --report                   # regenerate this file from dist/<variant>/svelte-tests*.json
```

`--without` skips whole techniques for bisecting. Techniques are cumulative: ASYNC's anchors assume LEGACY ran first, so a combination that breaks an anchor fails loudly at patch time. The Svelte location comes from `scripts/link-svelte.ts`, so `SVELTE_DIR=…`, `SVELTE_REF` and `svelte-ref.json` all work.

**Timing** (8-core Mac):

| run | wall time |
| --- | --- |
| `optimized`, async on, cold (reference runs in parallel) | 1.5 min |
| `optimized`, async off | 2.5 min |
| `minimal`, cold | 2.5–3 min |
| `minimal`, reference cached | 2.5 min |

The unpatched no-async reference alone takes 2.4 min.

<!-- generated by scripts/svelte-tests.ts; do not edit below this line by hand -->

## `optimized` (async mode on)

Svelte `f90853565966bc0bab57c99fe7d669a91bef0f4c` · async mode **on** (suite default: runes tests compiled with experimental.async) · 91s · techniques not applied: DEV_CONST (dev-mode tests need DEV from esm-env; runtime-production mocks DEV=false)

| suite | reference pass / fail / skip | variant pass / fail / skip | unexpected | expected |
| --- | ---: | ---: | ---: | ---: |
| runtime-runes | 2707 / 0 / 34 | 2707 / 0 / 34 | 0 | 0 |
| runtime-legacy | 3303 / 1 / 10 | 3303 / 1 / 10 | 0 | 0 |
| runtime-production | 14 / 0 / 0 | 14 / 0 / 0 | 0 | 0 |
| runtime-xhtml | 25 / 0 / 0 | 25 / 0 / 0 | 0 | 0 |
| hydration | 84 / 0 / 0 | 84 / 0 / 0 | 0 | 0 |
| signals | 105 / 0 / 2 | 105 / 0 / 2 | 0 | 0 |
| store | 33 / 0 / 0 | 33 / 0 / 0 | 0 | 0 |
| motion | 8 / 0 / 0 | 8 / 0 / 0 | 0 | 0 |
| runtime-browser | 102 / 0 / 0 | 102 / 0 / 0 | 0 | 0 |
| unit | 141 / 0 / 0 | 141 / 0 / 0 | 0 | 0 |

### Unexpected regressions (0)

None.

### Expected failures, by dropped feature (0)

None.

## `optimized` (async mode off)

Svelte `f90853565966bc0bab57c99fe7d669a91bef0f4c` · async mode **off** (SVELTE_NO_ASYNC=true, as in the official TestNoAsync CI job) · 154s · techniques not applied: DEV_CONST (dev-mode tests need DEV from esm-env; runtime-production mocks DEV=false)

| suite | reference pass / fail / skip | variant pass / fail / skip | unexpected | expected |
| --- | ---: | ---: | ---: | ---: |
| runtime-runes | 1826 / 0 / 9 | 1826 / 0 / 9 | 0 | 0 |
| runtime-legacy | 3301 / 1 / 10 | 3301 / 1 / 10 | 0 | 0 |
| runtime-production | 11 / 0 / 0 | 11 / 0 / 0 | 0 | 0 |
| runtime-xhtml | 24 / 0 / 0 | 24 / 0 / 0 | 0 | 0 |
| hydration | 84 / 0 / 0 | 84 / 0 / 0 | 0 | 0 |
| signals | 104 / 1 / 2 | 104 / 1 / 2 | 0 | 0 |
| store | 33 / 0 / 0 | 33 / 0 / 0 | 0 | 0 |
| motion | 8 / 0 / 0 | 8 / 0 / 0 | 0 | 0 |
| runtime-browser | 102 / 0 / 0 | 102 / 0 / 0 | 0 | 0 |
| unit | 141 / 0 / 0 | 141 / 0 / 0 | 0 | 0 |

### Unexpected regressions (0)

None.

### Expected failures, by dropped feature (0)

None.

## `optimized--with-dev-const` (async mode on)

Svelte `f90853565966bc0bab57c99fe7d669a91bef0f4c` · async mode **on** (suite default: runes tests compiled with experimental.async) · 63s · techniques not applied: 

| suite | reference pass / fail / skip | variant pass / fail / skip | unexpected | expected |
| --- | ---: | ---: | ---: | ---: |
| runtime-production | 14 / 0 / 0 | 14 / 0 / 0 | 0 | 0 |
| runtime-browser | 102 / 0 / 0 | 102 / 0 / 0 | 0 | 0 |

### Unexpected regressions (0)

None.

### Expected failures, by dropped feature (0)

None.

## `minimal` (async mode off)

Svelte `f90853565966bc0bab57c99fe7d669a91bef0f4c` · async mode **off** (SVELTE_NO_ASYNC=true, as in the official TestNoAsync CI job) · 68s · techniques not applied: DEV_CONST (dev-mode tests need DEV from esm-env; runtime-production mocks DEV=false)

| suite | reference pass / fail / skip | variant pass / fail / skip | unexpected | expected |
| --- | ---: | ---: | ---: | ---: |
| runtime-runes | 1826 / 0 / 9 | 1766 / 60 / 9 | 0 | 60 |
| runtime-legacy | 3301 / 1 / 10 | 0 / 3302 / 10 | 0 | 3301 |
| runtime-production | 11 / 0 / 0 | 11 / 0 / 0 | 0 | 0 |
| runtime-xhtml | 24 / 0 / 0 | 24 / 0 / 0 | 0 | 0 |
| hydration | 84 / 0 / 0 | 19 / 65 / 0 | 0 | 65 |
| signals | 104 / 1 / 2 | 104 / 1 / 2 | 0 | 1 |
| store | 33 / 0 / 0 | 33 / 0 / 0 | 0 | 0 |
| motion | 8 / 0 / 0 | 8 / 0 / 0 | 0 | 0 |
| runtime-browser | 102 / 0 / 0 | 26 / 76 / 0 | 0 | 76 |
| unit | 141 / 0 / 0 | 109 / 0 / 32 | 0 | 32 |

### Unexpected regressions (0)

None.

### Expected failures, by dropped feature (3535)

<details><summary><b>legacy</b>: 3234 test(s)</summary>

Detected by: hit the svelte-lite stub for legacy mode (Svelte 4 syntax) (3202); compiled output enables legacy mode (non-runes component) (3234); compiled output uses legacy runtime helpers (1298); runtime-legacy suite: non-runes components (createClassComponent, legacy mode) (3076); sample opts out of runes (17)

Per suite: hydration 64, runtime-legacy 3076, runtime-browser 76, runtime-runes 18

- `hydration/test.ts :: basic`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: binding-input`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: boundary-mismatch-recovery`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: claim-comment`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: claim-static`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: claim-text`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: cloudflare-mirage-borking`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: cloudflare-mirage-borking-2`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: component`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: component-in-element`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: css-props-hmr`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: custom-element-with-settable-only-property`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `hydration/test.ts :: dynamic-element-child-mismatch`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: dynamic-text`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: dynamic-text-changed`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: dynamic-text-nil`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: each-block`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: each-block-arg-clash`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `hydration/test.ts :: each-else`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: each-preserve-whitespace`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: each-text-only`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: element-attribute-added`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: element-attribute-changed`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: element-attribute-removed`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: element-attribute-unchanged`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: element-dir-attribute-sibling`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: element-nested`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: element-nested-sibling`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: element-ref`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: event-handler`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: expression-sibling`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: head-css-no-class`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: head-html-and-component`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: head-meta-hydrate-duplicate`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: head-missing`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: html-tag-hydration`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: if-block`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: if-block-anchor`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: if-block-empty`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: if-block-false`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: if-block-update`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: input-checked-attribute-sibling`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: no-reset-debug`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: no-reset-snippet`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: noscript`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `hydration/test.ts :: option-rich-content-static`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: raw`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: raw-empty`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: raw-mismatch-static`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: raw-repair`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: raw-svg`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: raw-with-empty-line-at-top`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: repairs-apparent-static-content`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: rich-select`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: safari-borking`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: safari-borking-2`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: script`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: snippet-raw-hydrate`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `hydration/test.ts :: standalone-component`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: standalone-snippet`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: surrounding-whitespace`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: text-fallback`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: top-level-text`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `hydration/test.ts :: whitespace-at-block-start`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > binding-files (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > binding-files (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > binding-width-height-initialize (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > binding-width-height-initialize (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > binding-width-height-this-timing (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > binding-width-height-this-timing (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > browser-events-ending-with-capture (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > browser-events-ending-with-capture (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties-dynamic (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties-dynamic (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties-dynamic-svg (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties-dynamic-svg (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-event-handler-contenteditable-false (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-event-handler-contenteditable-false (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-slot-binding-dimensions (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-slot-binding-dimensions (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > css-props-dynamic-component (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > css-props-dynamic-component (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > dynamic-element-custom-element (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > dynamic-element-hydration-preserves-connection (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > dynamic-element-hydration-preserves-connection (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > head-script (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > head-script (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > head-scripts (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > html-tag-script (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > html-tag-script-2 (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-important (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-important (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-precedence (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-precedence (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-update-with-spread (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-update-with-spread (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > mount-in-iframe (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > mount-in-iframe (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties-dynamic (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties-dynamic (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties2 (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties2 (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties-dynamic (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties-dynamic (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties2 (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties2 (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > $$props`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > $$slot`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > $$slot-dynamic-content`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > action`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > camel-case-attribute`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > ce-options-valid`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > closed-shadow-dom`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > custom-class`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > custom-method`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > deferred-nested-styles`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > escaped-css`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > events`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > extended-builtin`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > html`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > html-slots`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > nested`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > new-styled`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > no-shadow-dom`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > no-tag`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > no-tag-ce-options`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > oncreate`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > ondestroy`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > propagate-prop-changes`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > props`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > reflect-attributes`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > reflect-attributes-add-remove`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > set-property-before-mounted`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > shadow-root-init-options`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-runes/test.ts :: before-update-in-legacy-child (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); sample opts out of runes; compiled output uses legacy runtime helpers
- `runtime-runes/test.ts :: before-update-in-legacy-child (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); sample opts out of runes; compiled output uses legacy runtime helpers
- `runtime-runes/test.ts :: before-update-in-legacy-child (ssr)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); sample opts out of runes; compiled output uses legacy runtime helpers
- `runtime-runes/test.ts :: binding-interop (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); sample opts out of runes; compiled output uses legacy runtime helpers
- `runtime-runes/test.ts :: binding-interop-derived (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); sample opts out of runes; compiled output uses legacy runtime helpers
- `runtime-runes/test.ts :: binding-interop-derived (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); sample opts out of runes; compiled output uses legacy runtime helpers
- `runtime-runes/test.ts :: binding-interop-derived (ssr)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); sample opts out of runes; compiled output uses legacy runtime helpers
- `runtime-runes/test.ts :: fine-grained-prop-reactive-statement (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); sample opts out of runes; compiled output uses legacy runtime helpers
- `runtime-runes/test.ts :: fine-grained-prop-reactive-statement (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); sample opts out of runes; compiled output uses legacy runtime helpers
- `runtime-runes/test.ts :: fine-grained-prop-reactive-statement (ssr)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); sample opts out of runes; compiled output uses legacy runtime helpers
- … 8 more in `dist/minimal/svelte-tests*.json`

</details>

<details><summary><b>legacy + transitions</b>: 225 test(s)</summary>

Detected by: runtime-legacy suite: non-runes components (createClassComponent, legacy mode) (225); hit the svelte-lite stub for legacy mode (Svelte 4 syntax) (225); compiled output enables legacy mode (non-runes component) (225); compiled output uses transition:/in:/out:/animate: (225); compiled output uses legacy runtime helpers (57); uses svelte/legacy (Svelte 4 component API) (2); mount/hydrate with intro: true (23)

Per suite: runtime-legacy 225


</details>

<details><summary><b>transitions</b>: 40 test(s)</summary>

Detected by: compiled output uses transition:/in:/out:/animate: (40)

Per suite: runtime-runes 40

- `runtime-runes/test.ts :: dynamic-component-transition (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: dynamic-component-transition (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: dynamic-if-component-transition (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: dynamic-if-component-transition (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: dynamic-transition (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: dynamic-transition (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: each-updates-12 (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: each-updates-12 (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: each-updates-13 (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: each-updates-13 (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: effect-tracking-transition (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: effect-tracking-transition (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: if-nested-template (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: if-nested-template (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: if-transition-inert (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: if-transition-inert (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: mount-intro-transition (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: mount-intro-transition (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-delayed (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-delayed (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-delayed-events-css (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-delayed-events-css (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-delayed-events-js (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-delayed-events-js (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-each (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-each (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-each-2 (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-each-2 (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-each-3 (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-each-3 (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-each-4 (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-each-4 (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-evaluation (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-evaluation (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-if (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-if (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-snippet (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-snippet (hydrate)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-static-subtree (dom)`: compiled output uses transition:/in:/out:/animate:
- `runtime-runes/test.ts :: transition-static-subtree (hydrate)`: compiled output uses transition:/in:/out:/animate:

</details>

<details><summary><b>async</b>: 34 test(s)</summary>

Detected by: hit the svelte-lite stub for experimental.async (3); compiled with experimental.async (1); compiled output uses async runtime ($.async/$.save/$.pending/…) (1); experimental.async in _config.js (1); <svelte:boundary> with pending (1); test file enables async mode in a hook (enable_async_mode_flag() throws) (32)

Per suite: hydration 1, signals 1, unit 32

- `hydration/test.ts :: boundary-pending-attribute`: hit the svelte-lite stub for experimental.async; compiled with experimental.async; compiled output uses async runtime ($.async/$.save/$.pending/…); experimental.async in _config.js; <svelte:boundary> with pending
- `signals/test.ts :: signals > effects do depend on state they own (runes mode)`: hit the svelte-lite stub for experimental.async
- `packages/svelte/src/internal/server/hydratable.test.ts :: treats replacement tokens in hydratable promise values as literals`: hit the svelte-lite stub for experimental.async; test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'sync children, async transformError' > 'escapes -->'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'sync children, async transformError' > 'escapes <!--'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'sync children, async transformError' > 'escapes <!-->'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'sync children, async transformError' > 'escapes <!--->'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'sync children, async transformError' > 'escapes multiple -->'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'sync children, async transformError' > 'escapes --->'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'sync children, async transformError' > 'no double-encoding'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'sync children, async transformError' > 'the terrifying special pointy boy'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'async children throw' > 'escapes -->'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'async children throw' > 'escapes <!--'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'async children throw' > 'escapes <!-->'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'async children throw' > 'escapes <!--->'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'async children throw' > 'escapes multiple -->'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'async children throw' > 'escapes --->'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'async children throw' > 'no double-encoding'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: boundary hydration comment escaping > 'async children throw' > 'the terrifying special pointy boy'`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > awaiting renderer gets async content`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > push accepts async functions in async context`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > push handles async functions with different timing`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > push async functions work with head content type`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > push async functions can be mixed with child renderers`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > push async functions are not supported in sync context`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > on_destroy yields callbacks in the correct order`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > on_destroy callbacks run when a sync render throws`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > on_destroy callbacks run when an async render rejects`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > on_destroy waits for in-flight renderers when an async render rejects`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > aborts in-flight renderers before waiting for them`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > on_destroy waits for every run invocation when an async render rejects`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > abort signals are scoped to a render`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > a throwing on_destroy callback does not mask a sync render error`: test file enables async mode in a hook (enable_async_mode_flag() throws)
- `packages/svelte/src/internal/server/renderer.test.ts :: async > a throwing on_destroy callback does not mask an async render error`: test file enables async mode in a hook (enable_async_mode_flag() throws)

</details>

<details><summary><b>root-boundary</b>: 2 test(s)</summary>

Detected by: mount/hydrate transformError option (2)

Per suite: runtime-runes 2

- `runtime-runes/test.ts :: error-boundary-26 (dom)`: mount/hydrate transformError option
- `runtime-runes/test.ts :: error-boundary-27 (dom)`: mount/hydrate transformError option

</details>

## `minimal--with-dev-const` (async mode off)

Svelte `f90853565966bc0bab57c99fe7d669a91bef0f4c` · async mode **off** (SVELTE_NO_ASYNC=true, as in the official TestNoAsync CI job) · 75s · techniques not applied: 

| suite | reference pass / fail / skip | variant pass / fail / skip | unexpected | expected |
| --- | ---: | ---: | ---: | ---: |
| runtime-production | 11 / 0 / 0 | 11 / 0 / 0 | 0 | 0 |
| runtime-browser | 102 / 0 / 0 | 26 / 76 / 0 | 0 | 76 |

### Unexpected regressions (0)

None.

### Expected failures, by dropped feature (76)

<details><summary><b>legacy</b>: 76 test(s)</summary>

Detected by: hit the svelte-lite stub for legacy mode (Svelte 4 syntax) (76); compiled output enables legacy mode (non-runes component) (76); compiled output uses legacy runtime helpers (21)

Per suite: runtime-browser 76

- `runtime-browser/test.ts :: runtime-browser > binding-files (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > binding-files (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > binding-width-height-initialize (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > binding-width-height-initialize (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > binding-width-height-this-timing (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > binding-width-height-this-timing (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > browser-events-ending-with-capture (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > browser-events-ending-with-capture (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties-dynamic (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties-dynamic (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties-dynamic-svg (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-css-custom-properties-dynamic-svg (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-event-handler-contenteditable-false (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-event-handler-contenteditable-false (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-slot-binding-dimensions (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > component-slot-binding-dimensions (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > css-props-dynamic-component (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > css-props-dynamic-component (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > dynamic-element-custom-element (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > dynamic-element-hydration-preserves-connection (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > dynamic-element-hydration-preserves-connection (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > head-script (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > head-script (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > head-scripts (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > html-tag-script (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > html-tag-script-2 (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-important (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-important (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-precedence (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-precedence (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-update-with-spread (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > inline-style-directive-update-with-spread (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > mount-in-iframe (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > mount-in-iframe (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties-dynamic (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties-dynamic (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties2 (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > svelte-component-css-custom-properties2 (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties-dynamic (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties-dynamic (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties2 (dom)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: runtime-browser > svelte-self-css-custom-properties2 (hydrate)`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > $$props`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > $$slot`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > $$slot-dynamic-content`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > action`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > camel-case-attribute`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > ce-options-valid`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > closed-shadow-dom`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > custom-class`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > custom-method`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > deferred-nested-styles`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > escaped-css`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > events`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > extended-builtin`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > html`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > html-slots`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > nested`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > new-styled`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > no-shadow-dom`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > no-tag`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > no-tag-ce-options`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > oncreate`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > ondestroy`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > propagate-prop-changes`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > props`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component); compiled output uses legacy runtime helpers
- `runtime-browser/test.ts :: custom-elements > reflect-attributes`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > reflect-attributes-add-remove`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > set-property-before-mounted`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)
- `runtime-browser/test.ts :: custom-elements > shadow-root-init-options`: hit the svelte-lite stub for legacy mode (Svelte 4 syntax); compiled output enables legacy mode (non-runes component)

</details>

## Harness self-check (deliberately broken patches)

Each run breaks one risky patch on purpose; the suite must report UNEXPECTED regressions.

| mutation | suites | unexpected regressions | e.g. |
| --- | --- | ---: | --- |
| no-delegation-install: lazy delegation without installing the root-listener hook in delegate() | runtime-runes, runtime-browser | **604** | `runtime-runes/test.ts :: abort-signal-derived-destroy (dom)` |
| no-hydrate-next: root-boundary patch without the hydrate_next() that consumes the SSR open marker | runtime-runes, hydration, runtime-browser | **663** | `hydration/test.ts :: each-block-0-on-server-more-on-client` |
| no-proxy-hook: runtime proxy patches applied, compiled $.set(x, v, true) NOT rewritten | runtime-runes, runtime-browser | **15** | `runtime-runes/test.ts :: class-private-fields-assignment-shorthand (dom)` |

