# PATCHES

svelte-lite is **not a fork**. `node_modules/svelte` is a symlink to an official Svelte checkout vendored by `bun run vendor <ref>` (`vendor/svelte/<ref>/packages/svelte`, selected in `svelte-ref.json`), which is never edited: the build refuses to run if it has uncommitted changes. Every variant is "official source + the patch list below", applied at build time by `plugins/patch.ts` in Bun's `onLoad` hook (client build only; SSR uses stock Svelte). The patch definitions live in `patches/optimized.ts` and `patches/minimal.ts`. The tables at the bottom are generated from those definitions by `bun scripts/patches-doc.ts`, which applies them to all 123 client runtime files, not just the files the test apps happen to import.

## How upstream drift is caught

Every patch fails the build loudly instead of silently becoming a no-op.

| mechanism | what fails the build |
| --- | --- |
| **Text edits** anchor on literal code: a string, a `code\`…\`` snippet (whitespace-insensitive, everything else literal) or a RegExp. | The anchor is missing, or it matches a different number of times than declared. |
| **Block moves/rewrites** (the two delegation blocks in `render.js`) are lazy RegExps plus a hash of the matched upstream text. | Upstream edits that block. |
| **Function replacements** (`replaceFunctions`) are pinned to a hash of the upstream function source. | Upstream edits the function. A replacement can never silently drop new upstream logic. |
| **Member/function removals** (`removeMembers`, `removeFunctions`) are done on the acorn AST. | The class or member is missing or ambiguous. A removed `#private` member that is still referenced is a parse error. For removed *public* methods, `build.ts` scans the bundle for any remaining `.method(` call. |
| **Regex-scoped patches** (e.g. the `Symbol()` PURE pass over `src/**`). | `patches-doc.ts` fails if one no longer applies to any file. |
| **Resolution**: `build.ts` checks the metafile (esm-env → `false.js`/`true.js`, `svelte` → `index-client.js`). | A dev or server file was bundled. |
| **Per-ref check without a build**: `bun run check.ts --anchors [--svelte=<ref>]` applies every patch to the selected (or given) vendored Svelte and lists each failing patch with its reason. | A patch targets a file that no longer exists; plus all of the above. |

## Compiled-output transforms and options (no runtime source touched)

These live in `plugins/svelte.ts` and run on the compiler's client output with an acorn AST plus magic-string.

| variant | transform / option | why |
| --- | --- | --- |
| optimized | `namedImports`: rewrite `import * as $ from 'svelte/internal/client'` into named imports, and set `optimizeImports: ['svelte']` | Lets Bun's barrel optimisation skip runtime modules nobody imports. This drops `custom-element.js`, whose top-level side effect keeps `legacy-client.js`, `flushSync()` and more alive. |
| optimized | `discloseVersion: false` | No `window.__svelte.v` registration |
| optimized | `postpass.ts`: delete `#private` class members that are never referenced, then re-bundle | Always safe. In `optimized` it finds nothing. In `minimal` (and m2–m5) it removes `BranchManager.#discard` in apps with `{#if}`/`{#each}` branches (`reactive`, `boundary`), which dies once `defer` folds to `false`. Every other dead private member is deleted explicitly by the patches. |
| minimal | `runes: true` | Legacy syntax (`export let`, `$:`, …) becomes a compile error |
| minimal | `forbid`: `$.transition`, `$.animation`, `$.pending`, and `$.boundary(…, { pending })` | Components using a removed feature fail the build with a `svelte-lite: … is not supported` message (see `scripts/negative.ts`) |
| minimal | `proxySet`: `$.set(x, v, true)` → `$.set(x, $.proxy(v))` | `set()` no longer needs to reference `proxy()`, so the proxy tree-shakes in apps without deep state. Any other 3-argument `$.set` fails the build. |

## Requested but not done (or done differently)

- **`mutable_source` in `each.js` was kept.** The ask was to replace it with `source()` for runes mode. It isn't legacy-only: runes components iterating a *store* (`{#each $store as item}`) compile without `EACH_ITEM_IMMUTABLE` and rely on `mutable_source`'s `safe_equals`. With `legacy_mode_flag` constant, `mutable_source()` already folds to `source()` + `safe_equals` (a few bytes), so the patch isn't needed.
- **`legacy_updates` was removed as requested, with one behaviour change.** In runes mode, a `set()` during traversal (e.g. from `$effect.pre`, or a store that emits while effects run) is now scheduled on the *current* batch, as `internal_set()` already does, instead of on a follow-up batch. The upstream comment says it exists for "legacy mode and stores". The test apps don't exercise stores. Treat this as the riskiest behavioural patch.
- **`#find_earlier_batch`/`#merge` were removed.** They come from the async linked-list rebasing ([sveltejs/svelte#18205](https://github.com/sveltejs/svelte/pull/18205)). In sync mode, two batches can only overlap if `flushSync()` is called inside an effect while the outer batch is flushing. Such a batch now commits on its own instead of merging, which is how sync Svelte behaved before #18205.
- **`<svelte:boundary>` error handling is kept.** Only the pending and `$effect.pending` members of `Boundary` go (the `boundary` app verifies `failed`, `onerror` and `reset()` after hydration). A boundary with a `pending` snippet fails the build, because the server renders `pending` and the client could no longer hydrate it.
- **The async `is_fork` readers were left in place.** They sit outside `Batch` (`runtime.js`, `deriveds.js`, `sources.js`). The field is gone, so they read `undefined`, which behaves like `false`. Patching each one would add patches for a few bytes.
- **`flatten()`, `pause_effects()`, `fork()`, `settled()` and `pending()` are hash-pinned whole-function replacements** rather than several scattered edits. In each case the replacement is a few lines (a stub, or the sync path only).

<!-- generated by scripts/patches-doc.ts; do not edit by hand -->
Generated against Svelte 5.57.1: `main` @ `f90853565966bc0bab57c99fe7d669a91bef0f4c` from https://github.com/sveltejs/svelte.git (`vendor/svelte/main`, selected via SVELTE_REF).

## Summary

| technique | variant | patches | files | upstream lines removed | lines added |
| --- | --- | ---: | ---: | ---: | ---: |
| optimized: DEV_CONST | optimized | 1 | 1 | 14 | 0 |
| optimized: PURE | optimized | 4 | 10 | 32 | 29 |
| minimal: LEGACY | minimal | 3 | 3 | 30 | 15 |
| minimal: ASYNC | minimal | 8 | 8 | 839 | 37 |
| minimal: TRANSITIONS | minimal | 4 | 4 | 149 | 24 |
| minimal: ROOT_BOUNDARY | minimal | 1 | 1 | 12 | 6 |
| minimal: DELEGATION | minimal | 2 | 2 | 59 | 58 |
| minimal: PROXY | minimal | 2 | 2 | 4 | 4 |
| constImports (dev) (DEV, BROWSER, NODE) | optimized | 1 | 43 | 65 | 93 |
| constImports (legacy) (legacy_mode_flag) | minimal | 1 | 4 | 16 | 14 |
| constImports (async) (async_mode_flag) | minimal | 1 | 9 | 19 | 19 |

- **optimized**: 6 patches, 49 files, −111 / +122 lines (plus the compiled-output transforms and options listed above).
- **minimal** (includes optimized): 28 patches, 51 files, −1239 / +299 lines.

## Every source patch

Lines are counted with `diff` against the file as it was before that patch (patches apply in this order).

| variant | technique | file (`src/…`) | ops | −/+ lines | what & why |
| --- | --- | --- | --- | ---: | --- |
| optimized | PURE | `constants.js` | 1 text edit | −3 / +3 | mark top-level `Symbol(...)` initialisers /*@__PURE__*/ so unused ones tree-shake |
| minimal | LEGACY | `internal/flags/index.js` | 2 text edits | −4 / +2 | legacy_mode_flag is a constant; enabling legacy mode throws |
| minimal | ASYNC | `internal/flags/index.js` | 3 text edits | −7 / +3 | async_mode_flag is a constant; enabling async mode throws |
| optimized | PURE | `internal/shared/attributes.js` | 1 text edit | −1 / +1 | wrap the `whitespace` string spread in a pure IIFE |
| optimized | PURE | `internal/client/constants.js` | 1 text edit | −11 / +11 | mark top-level `Symbol(...)` initialisers /*@__PURE__*/ so unused ones tree-shake |
| optimized | PURE | `internal/client/constants.js` | 1 text edit | −4 / +1 | IS_XHTML reads globalThis.document at module init; wrap in a pure IIFE |
| optimized | DEV_CONST | `internal/client/proxy.js` | remove fn update_path | −14 / +0 | dev-only nested update_path() (its only use is `if (DEV && ...) return update_path`); Bun never removes unused nested functions, and it keeps tag()/get_label() alive |
| minimal | PROXY | `internal/client/proxy.js` | 1 text edit | −1 / +1 | the one runtime-internal `set(s, v, true)` call (defineProperty trap) proxies explicitly |
| minimal | ASYNC | `internal/client/runtime.js` | replace fn settled (hash-pinned) | −3 / +1 | settled() waits for async work; stub |
| minimal | TRANSITIONS | `internal/client/render.js` | 2 text edits | −2 / +0 | should_intro only gates intro transitions |
| minimal | ROOT_BOUNDARY | `internal/client/render.js` | 5 text edits | −12 / +6 | _mount renders the component in a plain branch instead of a root Boundary (loses the `transformError` option and root-level pending/failed handling). The SSR root is `<!--[-->app<!--]-->` with no boundary-specific marker: the Boundary only consumed the opening `<!--[-->`, so _mount now does that itself (hydrate_next()); the closing marker check is unchanged |
| minimal | DELEGATION | `internal/client/render.js` | 5 text edits | −59 / +5 | _mount keeps its per-root registration hook but delegates listener management to events.js `delegation` (null until a component calls delegate()) |
| minimal | LEGACY | `internal/client/reactivity/batch.js` | 5 text edits | −13 / +6 | drop `legacy_updates` (set() during traversal is deferred to a new batch only for legacy `$:`/stores); writes during traversal are scheduled on the current batch like internal_set() |
| minimal | ASYNC | `internal/client/reactivity/batch.js` | 14 text edits; remove 27 Batch members; replace fn fork (hash-pinned) | −546 / +16 | strip the async/fork-only members of Batch and their call sites in #process/#traverse/discard/schedule/capture (sync batches never defer, fork or rebase) |
| minimal | ASYNC | `internal/client/reactivity/effects.js` | 1 text edit | −1 / +1 | effects are only registered with the batch for fork rebasing |
| minimal | TRANSITIONS | `internal/client/reactivity/effects.js` | 5 text edits | −43 / +5 | no transitions: destroy/pause/resume never collect, run or stop `effect.nodes.t`; unmount({ outro }) destroys immediately |
| optimized | PURE | `internal/client/reactivity/store.js` | 1 text edit | −1 / +1 | mark top-level `Symbol(...)` initialisers /*@__PURE__*/ so unused ones tree-shake |
| optimized | PURE | `internal/client/reactivity/deriveds.js` | 1 text edit | −1 / +1 | mark top-level `Symbol(...)` initialisers /*@__PURE__*/ so unused ones tree-shake |
| minimal | ASYNC | `internal/client/reactivity/async.js` | replace fn flatten (hash-pinned) | −67 / +6 | template_effect -> flatten(): keep the sync fast path, the async slow path (async_derived, blockers) throws |
| minimal | LEGACY | `internal/client/reactivity/sources.js` | 7 text edits | −13 / +7 | set() no longer routes through `legacy_updates`; mark_reactions always schedules |
| minimal | PROXY | `internal/client/reactivity/sources.js` | 3 text edits | −3 / +3 | set() loses its `should_proxy` flag and its reference to proxy(); callers that need a proxy pass `proxy(value)` (compiled code via plugins/svelte.ts, proxy.js below) |
| optimized | PURE | `internal/client/dom/blocks/key.js` | 1 text edit | −1 / +1 | mark top-level `Symbol(...)` initialisers /*@__PURE__*/ so unused ones tree-shake |
| minimal | ASYNC | `internal/client/dom/blocks/boundary.js` | 6 text edits; remove 18 Boundary members; replace fn pending (hash-pinned) | −207 / +6 | strip pending-snippet / $effect.pending members of Boundary (error boundaries keep working); pending() throws |
| minimal | ASYNC | `internal/client/dom/blocks/each.js` | 2 text edits; remove fn discard | −7 / +2 | should_defer_append() is always false without async; fold the multi-batch skip/commit/discard paths (the const must lead its function body for Bun to fold it) |
| minimal | TRANSITIONS | `internal/client/dom/blocks/each.js` | 4 text edits; replace fn pause_effects (hash-pinned) | −84 / +14 | no animate:/outros in {#each}: is_animated is constant false, removed items are destroyed immediately (no outro groups) |
| minimal | ASYNC | `internal/client/dom/blocks/branches.js` | 2 text edits | −1 / +2 | should_defer_append() is always false without async; fold the offscreen/multi-batch paths (the const must lead its function body for Bun to fold it) |
| minimal | TRANSITIONS | `internal/client/dom/blocks/branches.js` | 5 text edits; remove 2 BranchManager members | −20 / +5 | no outros in if/key/component branches: switched-away branches are destroyed immediately (#outroing, #transition gone) |
| optimized | PURE | `internal/client/dom/elements/events.js` | 1 text edit | −1 / +1 | mark top-level `Symbol(...)` initialisers /*@__PURE__*/ so unused ones tree-shake |
| minimal | DELEGATION | `internal/client/dom/elements/events.js` | 2 text edits | −0 / +53 | root-listener bookkeeping (register/unregister, moved from render.js) is installed by the first delegate() call |
| optimized | PURE | `internal/client/dom/elements/attributes.js` | 1 text edit | −4 / +4 | mark top-level `Symbol(...)` initialisers /*@__PURE__*/ so unused ones tree-shake |
| optimized | PURE | `reactivity/url-search-params.js` | 1 text edit | −1 / +1 | mark top-level `Symbol(...)` initialisers /*@__PURE__*/ so unused ones tree-shake |
| optimized | PURE | `utils.js` | 2 text edits | −4 / +4 | wrap spread arrays (DOM_PROPERTIES, RUNES) in pure IIFEs so they tree-shake when unused |
| optimized | constImports (dev) | 43 files: `transition/index.js`, `index-client.js`, `internal/shared/warnings.js`, `internal/shared/dev.js`, `internal/shared/errors.js`, `internal/shared/clone.js`, `internal/client/warnings.js`, `internal/client/proxy.js`, `internal/client/runtime.js`, `internal/client/error-handling.js`, `internal/client/hydratable.js`, `internal/client/render.js`, `internal/client/errors.js`, `internal/client/reactivity/batch.js`, `internal/client/reactivity/effects.js`, `internal/client/reactivity/store.js`, `internal/client/reactivity/deriveds.js`, `internal/client/reactivity/async.js`, `internal/client/reactivity/props.js`, `internal/client/reactivity/sources.js`, `internal/client/dom/blocks/html.js`, `internal/client/dom/blocks/snippet.js`, `internal/client/dom/blocks/boundary.js`, `internal/client/dom/blocks/each.js`, `internal/client/dom/blocks/branches.js`, `internal/client/dom/blocks/await.js`, `internal/client/dom/blocks/svelte-element.js`, `internal/client/dom/elements/attributes.js`, `internal/client/dom/elements/bindings/input.js`, `internal/client/dom/operations.js`, `internal/client/dom/css.js`, `internal/client/context.js`, `internal/client/timing.js`, `legacy/legacy-client.js`, `motion/tweened.js`, `motion/spring.js`, `reactivity/url-search-params.js`, `reactivity/set.js`, `reactivity/create-subscriber.js`, `reactivity/window/index.js`, `reactivity/date.js`, `reactivity/url.js`, `reactivity/map.js` | import { DEV, BROWSER, NODE } from 'esm-env' → hoisted const | −65 / +93 | esm-env value (as resolved by the production/browser conditions) as a foldable local const |
| minimal | constImports (legacy) | 4 files: `index-client.js`, `internal/client/reactivity/props.js`, `internal/client/reactivity/sources.js`, `internal/client/context.js` | import { legacy_mode_flag } from 'src/internal/flags/index.js' → hoisted const | −16 / +14 | runes-only: legacy_mode_flag as a foldable const (is_runes() becomes `true`) |
| minimal | constImports (async) | 9 files: `internal/client/runtime.js`, `internal/client/hydratable.js`, `internal/client/reactivity/batch.js`, `internal/client/reactivity/deriveds.js`, `internal/client/dom/elements/bindings/select.js`, `internal/client/dom/elements/bindings/input.js`, `internal/client/dom/operations.js`, `internal/client/context.js`, `legacy/legacy-client.js` | import { async_mode_flag } from 'src/internal/flags/index.js' → hoisted const | −19 / +19 | sync-only: async_mode_flag as a foldable const |
