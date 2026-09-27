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

| app | baseline | optimized | minimal |
| --- | ---: | ---: | ---: |
| hello, min / gzip | 41,544 / 15,542 | 27,372 / 10,575 (−34% / −32%) | **11,836 / 5,098 (−72% / −67%)** |
| reactive, min / gzip | 61,138 / 22,801 | 44,355 / 17,117 (−27% / −25%) | **31,896 / 13,010 (−48% / −43%)** |

`optimized` is lossless for every app: DEV constant, barrel imports, PURE annotations, `discloseVersion: false` and the private-member post-pass. `minimal` additionally drops legacy mode, async, transitions/animations, the root boundary, eager delegation and the always-bundled proxy.

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

**Warning: these reports were built from different Svelte sources:**

- Svelte 5.57.1 (exact source not recorded: built before svelte-ref.json): baseline/hello, optimized/hello, baseline/reactive, optimized/reactive, m1-legacy/hello, m1-legacy/reactive, m2-async/hello, m2-async/reactive, m3-transitions/hello, m3-transitions/reactive, m4-boundary/hello, m4-boundary/reactive, m5-delegation/hello, m5-delegation/reactive, baseline/boundary, optimized/boundary, baseline/stores, optimized/stores
- Svelte 5.57.1 (main, f90853565966, https://github.com/sveltejs/svelte.git): minimal/hello, minimal/reactive, minimal/boundary, minimal/stores

## Sizes: app × variant (`main.min.js`)

| app | variant | raw | gzip | brotli | Δ raw vs baseline | Δ gzip | Δ brotli |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| hello | baseline | 41,544 | 15,542 | 13,977 |  |  |  |
| hello | optimized | 27,372 | 10,575 | 9,607 | −14,172 (−34.1%) | −4,967 (−32.0%) | −4,370 (−31.3%) |
| hello | **minimal** | 11,836 | 5,098 | 4,618 | −29,708 (−71.5%) | −10,444 (−67.2%) | −9,359 (−67.0%) |
| reactive | baseline | 61,138 | 22,801 | 20,470 |  |  |  |
| reactive | optimized | 44,355 | 17,117 | 15,455 | −16,783 (−27.5%) | −5,684 (−24.9%) | −5,015 (−24.5%) |
| reactive | **minimal** | 31,896 | 13,010 | 11,784 | −29,242 (−47.8%) | −9,791 (−42.9%) | −8,686 (−42.4%) |

## Stacking: one feature drop at a time on top of `optimized`

Each row adds one technique to the row above; Δ is the marginal saving of that step (negative = smaller).

| step | variant | hello min | Δ min | hello gzip | Δ gzip | reactive min | Δ min | reactive gzip | Δ gzip |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| vanilla | `baseline` | 41,544 |  | 15,542 |  | 61,138 |  | 22,801 |  |
| lossless build fixes | `optimized` | 27,372 | −14,172 | 10,575 | −4,967 | 44,355 | −16,783 | 17,117 | −5,684 |
| + drop legacy mode | `m1-legacy` | 27,158 | −214 | 10,495 | −80 | 44,081 | −274 | 17,026 | −91 |
| + drop async | `m2-async` | 15,782 | −11,376 | 6,646 | −3,849 | 35,103 | −8,978 | 14,093 | −2,933 |
| + drop transitions/animations | `m3-transitions` | 15,509 | −273 | 6,556 | −90 | 33,723 | −1,380 | 13,635 | −458 |
| + skip root boundary | `m4-boundary` | 13,078 | −2,431 | 5,657 | −899 | 31,799 | −1,924 | 12,984 | −651 |
| + lazy event delegation | `m5-delegation` | 11,836 | −1,242 | 5,098 | −559 | 31,915 | +116 | 13,017 | +33 |
| + tree-shakable $state proxy | `minimal` | 11,836 | 0 | 5,098 | 0 | 31,896 | −19 | 13,010 | −7 |

## What still ships in `minimal`

### hello (11,836 B min, 5,098 B gzip)

Coverage while hydrating + running the app test: **ran 6,121 B**, never ran 4,347 B, module-init data 1,367 B.

| category | min B | share | gzip Δ (if removed) |
| --- | ---: | ---: | ---: |
| signals (sources/deriveds/runtime) | 3,074 | 26.0% | 1,167 |
| batch/scheduling | 2,869 | 24.2% | 1,127 |
| effects | 1,744 | 14.7% | 633 |
| template/dom ops | 1,382 | 11.7% | 563 |
| mount/render | 1,000 | 8.4% | 469 |
| shared utils/constants | 816 | 6.9% | 496 |
| boundary/async | 292 | 2.5% | 92 |
| app | 147 | 1.2% | 72 |
| errors | 146 | 1.2% | 40 |
| warnings | 136 | 1.1% | 34 |

| top modules | min B | gzip Δ |
| --- | ---: | ---: |
| `internal/client/reactivity/batch.js` | 2,620 | 1,023 |
| `internal/client/runtime.js` | 2,097 | 810 |
| `internal/client/reactivity/effects.js` | 1,744 | 633 |
| `internal/client/render.js` | 1,000 | 469 |
| `internal/client/reactivity/deriveds.js` | 674 | 234 |
| `internal/client/dom/operations.js` | 638 | 234 |
| `internal/client/dom/template.js` | 474 | 185 |
| `internal/client/constants.js` | 444 | 290 |
| `internal/client/error-handling.js` | 292 | 92 |
| `internal/client/context.js` | 288 | 111 |

| largest functions/methods that never ran | min B |
| --- | ---: |
| `remove_reaction` (internal/client/runtime.js) | 316 |
| `Batch.#traverse` (internal/client/reactivity/batch.js) | 291 |
| `destroy_effect` (internal/client/reactivity/effects.js) | 282 |
| `update_derived` (internal/client/reactivity/deriveds.js) | 247 |
| `Batch.#resolve` (internal/client/reactivity/batch.js) | 221 |
| `schedule_possible_effect_self_invalidation` (internal/client/runtime.js) | 217 |
| `invoke_error_boundary` (internal/client/error-handling.js) | 197 |
| `is_dirty` (internal/client/runtime.js) | 193 |
| `freeze_derived_effects` (internal/client/reactivity/deriveds.js) | 192 |
| `create_element` (internal/client/dom/operations.js) | 182 |

### reactive (31,896 B min, 13,010 B gzip)

Coverage while hydrating + running the app test: **ran 25,860 B**, never ran 2,898 B, module-init data 3,137 B.

| category | min B | share | gzip Δ (if removed) |
| --- | ---: | ---: | ---: |
| dom elements/bindings/blocks | 7,118 | 22.3% | 2,755 |
| signals (sources/deriveds/runtime) | 6,359 | 19.9% | 2,264 |
| batch/scheduling | 3,045 | 9.5% | 1,145 |
| effects | 2,550 | 8.0% | 886 |
| shared utils/constants | 2,400 | 7.5% | 1,141 |
| template/dom ops | 2,151 | 6.7% | 777 |
| app | 2,135 | 6.7% | 1,041 |
| proxy ($state objects) | 2,035 | 6.4% | 784 |
| events | 1,421 | 4.5% | 565 |
| mount/render | 1,109 | 3.5% | 469 |

| top modules | min B | gzip Δ |
| --- | ---: | ---: |
| `internal/client/runtime.js` | 3,605 | 1,283 |
| `internal/client/dom/blocks/each.js` | 3,048 | 1,242 |
| `internal/client/reactivity/batch.js` | 2,757 | 1,044 |
| `internal/client/reactivity/effects.js` | 2,550 | 886 |
| `internal/client/proxy.js` | 2,035 | 784 |
| `apps/reactive/App.svelte` | 1,878 | 893 |
| `internal/client/dom/elements/events.js` | 1,421 | 565 |
| `internal/client/dom/operations.js` | 1,404 | 482 |
| `internal/shared/attributes.js` | 1,350 | 564 |
| `internal/client/reactivity/sources.js` | 1,279 | 458 |

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
| `infinite_loop_guard` (internal/client/reactivity/batch.js) | 120 |
| `flush_eager_effects` (internal/client/reactivity/sources.js) | 111 |

## Verification apps (sizes for reference)

`boundary` exercises `<svelte:boundary>` failed/onerror/reset after hydration; `stores` exercises stores in runes mode, `{#each $store}` with in-place mutation and `$effect.pre` writing state during traversal. Both pass the same behavioural checks in every variant.

| app | variant | raw | gzip | brotli | Δ raw vs baseline | Δ gzip | Δ brotli |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| boundary | baseline | 48,850 | 18,172 | 16,327 |  |  |  |
| boundary | optimized | 33,587 | 12,815 | 11,627 | −15,263 (−31.2%) | −5,357 (−29.5%) | −4,700 (−28.8%) |
| boundary | **minimal** | 24,594 | 9,909 | 8,943 | −24,256 (−49.7%) | −8,263 (−45.5%) | −7,384 (−45.2%) |
| stores | baseline | 54,540 | 20,310 | 18,239 |  |  |  |
| stores | optimized | 37,892 | 14,609 | 13,237 | −16,648 (−30.5%) | −5,701 (−28.1%) | −5,002 (−27.4%) |
| stores | **minimal** | 24,227 | 10,016 | 9,135 | −30,313 (−55.6%) | −10,294 (−50.7%) | −9,104 (−49.9%) |

