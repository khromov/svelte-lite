# COMPARISON: vanilla vs optimized vs minimal (SSR + hydrate)

Svelte 5.57.1 (official source, never edited: upstream `main` @ `f90853565966`, 10 commits after the `svelte@5.57.1` tag, see "How to run") · Bun 1.4.2 · every number is `main.min.js` of a client bundle whose entry calls `hydrate(App, { target })` on server-rendered HTML.

## Setup

- **Apps** (`apps/<app>/`):
  - `hello` is the Phase-1 Hello World.
  - `reactive` uses: `$state` counter with a delegated `onclick`; `$derived`; `{#if}/{:else}`; keyed `{#each}` with add/remove; deep state (`items.push`, `item.done = …`, `settings.color = …`, and reassigning a fresh array); `bind:value`; `class:` and `style:`; a child component with `$props`; a snippet with `{@render}`, also passed as `children`.
  - Two extra verification apps are built for every variant too: `boundary` (`<svelte:boundary>` failed/onerror/reset) and `stores` (stores in runes mode, `$effect.pre` writes).
- **SSR.** Each app is compiled with `generate: 'server'` and rendered with `render()` from `svelte/server`, using the *unpatched* server runtime. The output goes into `dist/<variant>/<app>/index.html` together with the client bundle.
- **Verification.** `bun run check.ts` passes for all 8 variants × 4 apps × 3 bundles (min, unminified, readable), plus a mismatch-recovery run per variant for `hello` and `reactive`: 112 runs in all. Each run loads the SSR HTML into happy-dom, keeps references to server-rendered nodes, hydrates, and asserts:
  - no exceptions, no unhandled rejections, and no `console.warn`/`console.error`. This includes Svelte's `hydration_mismatch` warning.
  - the SSR nodes were reused: the same node identity after hydration, including keyed `{#each}` rows across add/remove.
  - every interaction listed above works. `minimal` passes exactly the same assertions as `baseline`.
  - `hydrate()`'s mismatch recovery still works: with the root `<!--]-->` removed, it warns `hydration_mismatch`, clears the target, renders on the client, and the app is interactive.

  The same command also verifies every patch anchor against all 123 client runtime files and runs the negative tests.
- **Svelte's own test suite** (`bun run test:svelte <variant>`, see **SVELTE_TESTS.md**). Compared with unpatched Svelte, `optimized` has 0 new failures in ~6,500 tests. `minimal` has 0 unexpected regressions: every new failure uses a dropped feature (legacy components, transitions, async, `transformError`).
- **Negative tests** (`scripts/negative.ts`). With `minimal`:
  - A legacy component (`export let`/`$:`), `transition:`, `animate:`, template `await`, `<svelte:boundary>` with `pending`, and `$effect.pending()` all **fail the build** with a clear message.
  - `fork()` and `settled()` throw `svelte-lite: … is not supported in this build`.

## How to run

```sh
bun install
bun run vendor 5.57.1          # official Svelte at tag svelte@5.57.1 -> vendor/svelte/5.57.1/ (see BASELINE.md "How to run")
bun run build.ts --all         # every variant x app -> dist/<variant>/<app>/, each report.json records the exact Svelte ref and sha
bun scripts/comparison.ts      # regenerates the tables below; the first generated line names the Svelte source
bun run check.ts --anchors     # which patches still apply to the selected Svelte (add --svelte=<ref> for another)
```

**Which Svelte these numbers are from.** They were built from upstream `main` @ `f90853565966bc0bab57c99fe7d669a91bef0f4c`, 10 commits after the `svelte@5.57.1` tag. `bun run vendor f90853565966bc0bab57c99fe7d669a91bef0f4c` reproduces every `main.min.js` byte for byte. On the tag itself:

- `baseline` and `optimized` differ by −5…+16 B min (+6…+24 B gzip). The 10 commits touch `runtime.js`, `batch.js`, `boundary.js`, `error-handling.js` and `each.js`.
- `minimal` and `m2`…`m5` don't build: the `ASYNC` technique's hash-pinned `fork()` replacement was written against the newer `fork()`. `bun run check.ts --anchors --svelte=5.57.1` reports it.

## Headline

| app | baseline | optimized | minimal | minimal + both flags |
| --- | ---: | ---: | ---: | ---: |
| hello, min / gzip | 41,544 / 15,542 | 27,059 / 10,428 (−34.9% / −32.9%) | **11,436 / 4,953 (−72.5% / −68.1%)** | 11,177 / 4,863 (−73.1% / −68.7%) |
| reactive, min / gzip | 61,138 / 22,801 | 43,605 / 16,846 (−28.7% / −26.1%) | **31,281 / 12,776 (−48.8% / −44.0%)** | 30,934 / 12,693 (−49.4% / −44.3%) |

- **`optimized`** is lossless for every app: DEV constant, barrel imports, PURE annotations, `discloseVersion: false`, and the dead-code post-pass. The post-pass removes unreferenced private members, constant-false branches and code after `return`, and leaves 0 B of provably dead code in every bundle (see COVERAGE.md).
- **`minimal`** additionally drops legacy mode, async, transitions/animations and the root boundary. It also makes event delegation lazy and the `$state` proxy tree-shakable.
- **Build flags** are opt-in and stack on any variant: `bun run build.ts minimal --strict-hydration --short-errors`.
  - `--strict-hydration` saves about 210–250 B min / 85–105 B gzip. A mismatch throws `hydration_failed` instead of re-rendering on the client.
  - `--short-errors` saves 13–165 B min, but gzip grows by 4–18 B. gzip already compresses the repeated `https://svelte.dev/e/` prefix, and the unique error codes stay. A throwaway test with numeric codes instead of names saved −292 B min / −73 B gzip on `reactive`. That was not adopted, because messages would become opaque numbers.

## Reading the stacking table

The order is fixed (legacy → async → transitions → root boundary → delegation → proxy). A step is credited with whatever becomes unreachable when it lands, so attribution depends on the order:

- **Async (−11.4 KB on hello, −9.0 KB on reactive).** This step includes the fork/rebase machinery of `Batch` (27 members), the `flatten()` async slow path (`async_derived` and friends), and the pending/`$effect.pending` half of `Boundary`.
  - `Batch` loses 4.2 KB in both apps and `Boundary` 1.6 KB.
  - On `reactive`, `async.js`/`deriveds.js` lose the async slow path (−1.4 KB).
  - On `hello` it also removes `$effect.pending`'s `createSubscriber`, which was the *only* path from `hydrate()` to `set()`. So `sources.js` and `proxy.js` leave the hello bundle here (−3.2 KB), not at the proxy step.
- **Root boundary (−2.4 KB / −1.9 KB).** The rest of `Boundary` (−1.7 KB: error/`failed`/reset/hydration members). Also its error and warning messages and, on `hello`, the hydration helpers only it used (`skip_nodes`, `next`).
- **Lazy delegation (−1.2 KB on hello, +116 B on reactive).** Delegation is not a feature drop: apps that use delegated events (`reactive`) keep all of it and pay a few bytes of indirection. Apps without any (`hello`) no longer ship `handle_event_propagation` and the root-listener bookkeeping.
- **Proxy (0 on hello, −19 B on reactive).** Both apps are the wrong shape for this step. `hello` lost `set()` at the async step, and `reactive` uses deep state, so it needs `proxy()` anyway. It pays off for apps that write state but have no deep state. A scratch counter-only app (`<button onclick={() => count++}>`, same pipeline, checks passing, not kept in `apps/`) measured:

  | counter app | min | Δ | gzip | Δ |
  | --- | ---: | ---: | ---: | ---: |
  | baseline | 45,558 | | 16,997 | |
  | optimized | 30,326 | −15,232 | 11,663 | −5,334 |
  | + legacy | 30,112 | −214 | 11,577 | −86 |
  | + async | 22,076 | −8,036 | 8,996 | −2,581 |
  | + transitions | 21,803 | −273 | 8,887 | −109 |
  | + root boundary | 19,357 | −2,446 | 8,009 | −878 |
  | + lazy delegation | 19,462 | +105 | 8,030 | +21 |
  | **+ proxy (= minimal)** | **17,135** | **−2,327** | **7,137** | **−893** |

- **Legacy (−214 / −274)** and **transitions (−273 hello / −1,380 reactive)** are small because the hooks they remove are small. For transitions, the `{#each}` outro groups and animation measuring account for most of reactive's saving.

## Root boundary vs SSR markers

Removing the root boundary doesn't desync hydration, but only because `_mount` now consumes the opening marker itself.

- **Server side.** `render()` emits the root as `<!--[-->…app…<!--]-->` (`Renderer.#open_render`). There is no boundary-specific marker at the root: failed-boundary markers (`<!--[?…-->`) and `pending` (`<!--[!-->`) are only emitted for explicit `<svelte:boundary>` elements.
- **What the client boundary did.** It consumed the opening `<!--[-->`: its block effect called `hydrate_next()` before rendering the children. The *closing* `<!--]-->` is checked by `_mount` itself.
- **What `minimal` does.** It removes the boundary and calls `hydrate_next()` in `_mount` before rendering the component into a plain `branch()`. Without that call, hydration starts on the comment node and mismatches.
- **How it's verified.** `hello` and `reactive` hydrate with node reuse. The mismatch run confirms that a missing close marker still takes `hydrate()`'s recovery path.
- **What is lost.** The `transformError` option of `mount`/`hydrate`, and root-level error handling. Errors now propagate out of `hydrate()`/effects exactly as they would past a boundary without `failed`/`onerror`. Nested user `<svelte:boundary>` elements keep working: the `boundary` app passes.

## What still ships in `minimal` (commentary; tables below)

- **`hello` is now the bare hydration engine: 11.8 KB min / 5.1 KB gzip.**
  - The biggest parts are the signal core (`runtime.js`, `deriveds.js`: `get`, `update_reaction`, `remove_reaction`, …), `Batch` (21 of its original 48 members remain: `#process`, `#traverse`, `#resolve`, `flush`, `ensure`, `capture`, linking, …), effects, template cloning and `_mount`/`hydrate`.
  - About 4.3 KB of it never runs in the test, mostly teardown (`destroy_effect`) and update paths (`#traverse`, `is_dirty`, `update_derived`) that a one-shot hydration doesn't reach. `invoke_error_boundary` is also still present.
- **`reactive`: 81% of what ships in `minimal` actually runs in its test** (25.9 of 31.9 KB). The rest is feature code the app legitimately uses:
  - `each.js` (3.0 KB)
  - the proxy (2.0 KB)
  - class/style/attribute helpers (`shared/attributes.js` 1.35 KB)
  - delegation (1.4 KB)
  - `bind:value`
- **Next candidates**, none done here:
  - `invoke_error_boundary`/`handle_error`, which no longer have a root boundary to talk to (~0.3 KB).
  - The remaining multi-batch bookkeeping in `each.js` (`state.pending`, offscreen items).
  - `BranchManager`'s `#offscreen` map.
  - Legacy `captured_signals` in `get()`.
  - Error/warning helpers collapsed into one `throw_code()`.
  - The `is_fork` readers left outside `Batch`.

## Patch set

See **PATCHES.md**.

- **`optimized`:** 6 source patches (one of them a constImports rule) over 49 files, −111 / +122 lines. Most of those lines are the `import { DEV } from 'esm-env'` → hoisted `const` rewrites. It also has 3 compiled-output/option changes and the post-pass.
- **`minimal`:** 28 source patches over 51 files, −1,250 / +295 lines.
  - 850 of the removed lines are whole async members deleted from `Batch` and `Boundary`.
  - 5 functions are hash-pinned replacements: `flatten`, `pause_effects`, `fork`, `settled`, `pending`.
  - 2 `render.js` blocks moved to `events.js` are also hash-pinned.

Every anchor fails the build if it no longer matches.

## Patches that were too risky or too large, and what was done instead

- **`mutable_source` in `each.js`: not removed.**
  - It is still needed in runes mode for `{#each $store as item}`: the compiler omits `EACH_ITEM_IMMUTABLE` when the collection is a store.
  - Verified: an experiment that swapped it for `source()` made the `stores` app's in-place store mutation stop re-rendering.
  - With `legacy_mode_flag` constant, `mutable_source` already folds to `source()` + `safe_equals`, so nothing is lost by keeping it.
- **`legacy_updates` plumbing: removed, with a behaviour change.** A runes-mode `set()` during effect traversal (`$effect.pre`, stores emitting while effects run) is now scheduled on the current batch instead of a follow-up batch.
  - The `stores` app exercises both cases and passes, and nothing loops.
  - This is still the most behaviour-changing patch. Upstream says the plumbing exists "for legacy mode and stores".
- **`#merge` / `#find_earlier_batch`: removed.** They come from async batch rebasing. In sync mode, batches only overlap when `flushSync()` is called inside an effect during a flush. Such a batch now commits on its own instead of being merged into the outer one, which is the pre-#18205 sync behaviour. No test app does this.
- **`Boundary`: only the pending half was removed.**
  - Removing it entirely would break user error boundaries, so `failed`/`onerror`/`reset` stay (verified by the `boundary` app).
  - `pending` snippets are rejected at build time. The server *renders* `pending`, and the stripped client could not hydrate it.
- **The async `is_fork` readers outside `Batch` were left.** The field is gone, so they read `undefined`, which behaves like `false`. Patching each one would cost patches for a few bytes.
- **Whole-function replacements instead of many scattered edits, for 5 functions.** The replacements are 1–12 lines each, and each is pinned to a hash of the upstream function, so upstream changes fail the build instead of being silently dropped.
- **Not blocked at build time:** `experimental: { async: true }` in compiler options. Components compiled that way import `svelte/internal/flags/async`, whose `enable_async_mode_flag()` now throws at startup with a svelte-lite message.

<!-- generated by scripts/comparison.ts; do not edit below this line by hand -->

Built from Svelte 5.57.1 (main, f90853565966, https://github.com/sveltejs/svelte.git) with Bun 1.4.2.

## Sizes: app × variant (`main.min.js`)

| app | variant | raw | gzip | brotli | Δ raw vs baseline | Δ gzip | Δ brotli |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| hello | baseline | 41,544 | 15,542 | 13,977 |  |  |  |
| hello | optimized | 27,059 | 10,428 | 9,429 | −14,485 (−34.9%) | −5,114 (−32.9%) | −4,548 (−32.5%) |
| hello | **minimal** | 11,436 | 4,953 | 4,489 | −30,108 (−72.5%) | −10,589 (−68.1%) | −9,488 (−67.9%) |
| hello | minimal+strict-hydration+short-errors | 11,177 | 4,863 | 4,408 | −30,367 (−73.1%) | −10,679 (−68.7%) | −9,569 (−68.5%) |
| reactive | baseline | 61,138 | 22,801 | 20,470 |  |  |  |
| reactive | optimized | 43,605 | 16,846 | 15,171 | −17,533 (−28.7%) | −5,955 (−26.1%) | −5,299 (−25.9%) |
| reactive | **minimal** | 31,281 | 12,776 | 11,571 | −29,857 (−48.8%) | −10,025 (−44.0%) | −8,899 (−43.5%) |
| reactive | minimal+strict-hydration+short-errors | 30,934 | 12,693 | 11,474 | −30,204 (−49.4%) | −10,108 (−44.3%) | −8,996 (−43.9%) |

## Stacking: one feature drop at a time on top of `optimized`

Each row adds one technique to the row above; Δ is the marginal saving of that step (negative = smaller).

| step | variant | hello min | Δ min | hello gzip | Δ gzip | reactive min | Δ min | reactive gzip | Δ gzip |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| vanilla | `baseline` | 41,544 |  | 15,542 |  | 61,138 |  | 22,801 |  |
| lossless build fixes | `optimized` | 27,059 | −14,485 | 10,428 | −5,114 | 43,605 | −17,533 | 16,846 | −5,955 |
| + drop legacy mode | `m1-legacy` | 26,844 | −215 | 10,354 | −74 | 43,338 | −267 | 16,751 | −95 |
| + drop async | `m2-async` | 15,393 | −11,451 | 6,493 | −3,861 | 34,488 | −8,850 | 13,854 | −2,897 |
| + drop transitions/animations | `m3-transitions` | 15,120 | −273 | 6,396 | −97 | 33,108 | −1,380 | 13,406 | −448 |
| + skip root boundary | `m4-boundary` | 12,679 | −2,441 | 5,518 | −878 | 31,184 | −1,924 | 12,753 | −653 |
| + lazy event delegation | `m5-delegation` | 11,436 | −1,243 | 4,953 | −565 | 31,300 | +116 | 12,786 | +33 |
| + tree-shakable $state proxy | `minimal` | 11,436 | 0 | 4,953 | 0 | 31,281 | −19 | 12,776 | −10 |
| + `--strict-hydration` (flag) | `minimal+strict-hydration` | 11,190 | −246 | 4,850 | −103 | 31,067 | −214 | 12,689 | −87 |
| + `--short-errors` (flag) | `minimal+strict-hydration+short-errors` | 11,177 | −13 | 4,863 | +13 | 30,934 | −133 | 12,693 | +4 |

## What still ships in `minimal`

### hello (11,436 B min, 4,953 B gzip)

Coverage while hydrating + running the app test: **ran 5,867 B**, never ran 4,270 B, module-init data 1,298 B.

| category | min B | share | gzip Δ (if removed) |
| --- | ---: | ---: | ---: |
| signals (sources/deriveds/runtime) | 3,060 | 26.8% | 1,175 |
| batch/scheduling | 2,561 | 22.4% | 1,004 |
| effects | 1,749 | 15.3% | 641 |
| template/dom ops | 1,382 | 12.1% | 571 |
| mount/render | 983 | 8.6% | 467 |
| shared utils/constants | 753 | 6.6% | 485 |
| boundary/async | 292 | 2.6% | 91 |
| app | 147 | 1.3% | 74 |
| errors | 146 | 1.3% | 43 |
| warnings | 136 | 1.2% | 36 |

| top modules | min B | gzip Δ |
| --- | ---: | ---: |
| `internal/client/reactivity/batch.js` | 2,319 | 904 |
| `internal/client/runtime.js` | 2,077 | 810 |
| `internal/client/reactivity/effects.js` | 1,749 | 641 |
| `internal/client/render.js` | 983 | 467 |
| `internal/client/reactivity/deriveds.js` | 679 | 238 |
| `internal/client/dom/operations.js` | 640 | 243 |
| `internal/client/dom/template.js` | 472 | 189 |
| `internal/client/constants.js` | 410 | 286 |
| `internal/client/error-handling.js` | 292 | 91 |
| `internal/client/context.js` | 289 | 114 |

| largest functions/methods that never ran | min B |
| --- | ---: |
| `remove_reaction` (internal/client/runtime.js) | 319 |
| `Batch.#traverse` (internal/client/reactivity/batch.js) | 288 |
| `destroy_effect` (internal/client/reactivity/effects.js) | 282 |
| `update_derived` (internal/client/reactivity/deriveds.js) | 248 |
| `Batch.#resolve` (internal/client/reactivity/batch.js) | 221 |
| `schedule_possible_effect_self_invalidation` (internal/client/runtime.js) | 215 |
| `invoke_error_boundary` (internal/client/error-handling.js) | 197 |
| `freeze_derived_effects` (internal/client/reactivity/deriveds.js) | 194 |
| `is_dirty` (internal/client/runtime.js) | 193 |
| `create_element` (internal/client/dom/operations.js) | 182 |

### reactive (31,281 B min, 12,776 B gzip)

Coverage while hydrating + running the app test: **ran 25,315 B**, never ran 2,828 B, module-init data 3,137 B.

| category | min B | share | gzip Δ (if removed) |
| --- | ---: | ---: | ---: |
| dom elements/bindings/blocks | 7,094 | 22.7% | 2,747 |
| signals (sources/deriveds/runtime) | 6,054 | 19.4% | 2,162 |
| batch/scheduling | 2,759 | 8.8% | 1,030 |
| effects | 2,550 | 8.2% | 885 |
| shared utils/constants | 2,400 | 7.7% | 1,143 |
| template/dom ops | 2,151 | 6.9% | 783 |
| app | 2,135 | 6.8% | 1,040 |
| proxy ($state objects) | 2,035 | 6.5% | 793 |
| events | 1,421 | 4.5% | 563 |
| mount/render | 1,109 | 3.5% | 473 |

| top modules | min B | gzip Δ |
| --- | ---: | ---: |
| `internal/client/runtime.js` | 3,300 | 1,175 |
| `internal/client/dom/blocks/each.js` | 3,034 | 1,242 |
| `internal/client/reactivity/effects.js` | 2,550 | 885 |
| `internal/client/reactivity/batch.js` | 2,471 | 929 |
| `internal/client/proxy.js` | 2,035 | 793 |
| `apps/reactive/App.svelte` | 1,878 | 892 |
| `internal/client/dom/elements/events.js` | 1,421 | 563 |
| `internal/client/dom/operations.js` | 1,404 | 487 |
| `internal/shared/attributes.js` | 1,350 | 565 |
| `internal/client/reactivity/sources.js` | 1,279 | 462 |

| largest functions/methods that never ran | min B |
| --- | ---: |
| `get_setters` (internal/client/dom/elements/attributes.js) | 257 |
| `schedule_possible_effect_self_invalidation` (internal/client/runtime.js) | 216 |
| `invoke_error_boundary` (internal/client/error-handling.js) | 199 |
| `freeze_derived_effects` (internal/client/reactivity/deriveds.js) | 195 |
| `unregister` (internal/client/dom/elements/events.js) | 180 |
| `depends_on_old_values` (internal/client/runtime.js) | 143 |
| `reconnect` (internal/client/runtime.js) | 133 |
| `move_effect` (internal/client/reactivity/effects.js) | 126 |
| `flush_eager_effects` (internal/client/reactivity/sources.js) | 111 |
| `unfreeze_derived_effects` (internal/client/reactivity/deriveds.js) | 98 |

## Verification apps (sizes for reference)

`boundary` exercises `<svelte:boundary>` failed/onerror/reset after hydration; `stores` exercises stores in runes mode, `{#each $store}` with in-place mutation and `$effect.pre` writing state during traversal. Both pass the same behavioural checks in every variant.

| app | variant | raw | gzip | brotli | Δ raw vs baseline | Δ gzip | Δ brotli |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| boundary | baseline | 48,850 | 18,172 | 16,327 |  |  |  |
| boundary | optimized | 33,270 | 12,683 | 11,461 | −15,580 (−31.9%) | −5,489 (−30.2%) | −4,866 (−29.8%) |
| boundary | **minimal** | 23,993 | 9,669 | 8,723 | −24,857 (−50.9%) | −8,503 (−46.8%) | −7,604 (−46.6%) |
| boundary | minimal+strict-hydration+short-errors | 23,583 | 9,581 | 8,643 | −25,267 (−51.7%) | −8,591 (−47.3%) | −7,684 (−47.1%) |
| stores | baseline | 54,540 | 20,310 | 18,239 |  |  |  |
| stores | optimized | 37,565 | 14,458 | 13,080 | −16,975 (−31.1%) | −5,852 (−28.8%) | −5,159 (−28.3%) |
| stores | **minimal** | 23,668 | 9,781 | 8,809 | −30,872 (−56.6%) | −10,529 (−51.8%) | −9,430 (−51.7%) |
| stores | minimal+strict-hydration+short-errors | 23,291 | 9,698 | 8,740 | −31,249 (−57.3%) | −10,612 (−52.3%) | −9,499 (−52.1%) |

