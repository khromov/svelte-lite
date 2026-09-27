# Svelte 5.57.1 Client Runtime: Feature Report

What features the Svelte client runtime has, how many lines of code (LOC) each one contributes, and how hard each would be to remove from a slimmed-down "lite" build.

- **Source:** `../svelte/packages/svelte`. Nothing in it was modified.
- **Scope:** `src/internal/client`, `src/internal/shared`, `src/internal/flags`, `disclose-version`, the public client sub-packages, and the part of `src/utils.js` the runtime uses.
- **LOC columns:**
  - **Raw** counts physical lines.
  - **Code** counts non-blank, non-comment lines, using an acorn tokenizer that matches `cloc` to within 1 line.
  - The runtime is heavily JSDoc'd, so **Code** is the number to compare.

**Totals:** the client runtime is **21,159 raw / 12,586 code lines**. The server runtime, summarized in §8, is a further 2,653 raw / 1,460 code lines.

**Removability legend:**

| Verdict | Meaning |
|---|---|
| **(a)** | Already tree-shaken when unused. You only pay for it if the app uses the feature. |
| **(b)** | Removable with a compile-time flag or `define` plus small patches. |
| **(c)** | Deeply entangled with the core. Hard to remove. |

> **Bundler note.** The byte measurements in this report come from Rollup 4.62, Rolldown 1.2.11 and esbuild 0.28, run by the research agent. The verdicts that depend on constant-folding mutable `let` flags differ between bundlers; see §5. Bun 1.4.2 folds *less* than all three, so some verdicts marked (a) here do **not** hold under Bun. The next section summarizes the differences; the full details are in `BASELINE.md`.

### Bun 1.4.2 addendum

The same Hello World is **41,527 B min / 15,531 B gzip** under Bun, versus 23,709 / 9,152 under Rollup. The gap comes from what Bun doesn't eliminate:

| Rollup verdict here | Under Bun 1.4.2 | Lossless fix (validated) | Saves (min / gzip) |
|---|---|---|---:|
| DEV code (a), folded via `esm-env` | **Ships.** Bun doesn't carry constants across modules, so every `if (DEV)` survives. | Plugin rewrites `import { DEV } from 'esm-env'` into a local `const` | −8,303 / −2,717 |
| Custom elements (a) | **Ships.** The top-level side effect in `custom-element.js` keeps it, and it drags in `svelte/legacy`, `hydrate()` and `flushSync()`. | Named imports from compiled components plus `optimizeImports: ['svelte']` | −5,304 / −1,773 |
| Hydration and legacy/async flags fold when unused | **Not folded.** Bun never folds a `let`. | Patch the flags into module-top `const`s | −1,464 / −574 |
| Class members | Unreferenced `#private` methods still ship (same as Rollup). | Post-pass deletes them | −2,038 / −610 |
| PURE data (`Symbol()`, `IS_XHTML`, …) | **Ships.** Bun treats it as having side effects. | `/*@__PURE__*/` annotations plus `discloseVersion: false` | −1,237 / −538 |

The first four fixes together (everything above except the private-member post-pass) bring Bun to 26,035 B min / 10,062 B gzip (−37% / −35%), with no feature loss. Adding the post-pass gives 24,005 / 9,428.

---

## 1. LOC by area

| Area | What it covers | Raw LOC | Code LOC | % of code | Removability |
|---|---|---:|---:|---:|---|
| Reactivity engine | Signals, deriveds, effect tree, batch scheduler, component context, error propagation, shared utils | 3,555 | 2,166 | 17.2% | (c) |
| Blocks | if/key/each/await/snippet/dynamic component/`<svelte:element>`/`<svelte:boundary>`/`{@html}`/`<svelte:head>`/CSS | 2,271 | 1,451 | 11.5% | (a), except boundary (b) |
| Transitions & motion | Transition runtime plus `svelte/transition`, `animate`, `motion`, `easing` | 2,037 | 1,136 | 9.0% | (a); hooks in core are (b)/(c) |
| DEV-only | `$inspect`, tracing, ownership, HMR, debug helpers, validation | 1,688 | 1,025 | 8.1% | (a), folded via `esm-env` |
| Async | `await` in templates, `$effect.pending`, forks, `settled`, multi-batch | 1,514 | 882 | 7.0% | (c), with (b) parts |
| `svelte/reactivity` | SvelteMap/Set/Date/URL, MediaQuery, `createSubscriber`, window | 1,370 | 758 | 6.0% | (a) |
| Element attributes | Attributes, spread, class, style, customizable `<select>` | 1,151 | 736 | 5.8% | (a) |
| Bindings | All `bind:` directives | 1,240 | 719 | 5.7% | (a) |
| Legacy (Svelte 4 compat) | `$:`, mutable sources, event modifiers, `<slot>`, `svelte/legacy`, `createEventDispatcher` | 1,096 | 630 | 5.0% | (a); ~23 core lines (b) |
| Error/warning messages | `errors.js`, `warnings.js` (289 of 533 code lines are DEV-only) | 956 | 533 | 4.2% | (a) |
| DOM templating + mount | `from_html`, `append`, tree walkers, `mount`/`unmount`, `set_text` | 865 | 499 | 4.0% | (c) |
| `$state` extras | Deep proxies, `$state.snapshot`, `$state.eager` | 584 | 396 | 3.1% | proxy (b), others (a) |
| Context / lifecycle / props | `setContext`…, `onMount`/`tick`, `$props`/rest/spread/`$bindable` | 640 | 359 | 2.9% | (a) |
| Stores | `svelte/store` plus `$store` subscriptions in components | 638 | 317 | 2.5% | (a) |
| Hydration | Hydration cursor, `hydrate()`, `hydratable()` | 421 | 255 | 2.0% | (a) Rollup / (b) esbuild |
| Custom elements | `SvelteElement`, `create_custom_element` | 344 | 240 | 1.9% | (a) Rollup / (b) esbuild |
| Entry/barrel/flags/version | Re-exports, `disclose-version`, flags | 231 | 213 | 1.7% | (a) |
| Events | Delegation plus `on()`/`svelte/events` | 369 | 206 | 1.6% | delegation (b) |
| Actions & attachments | `use:`, `{@attach}`, `fromAction` | 189 | 65 | 0.5% | (a) |
| **Total** | | **21,159** | **12,586** | 100% | |

**LOC is not the same as shipped bytes.** Most of these areas are category (a): an app that doesn't use them doesn't ship them. The real bloat is code that ships to *every* app whether or not it's used (§4 and §5). Most of it is async machinery, the root `<svelte:boundary>`, event delegation and the proxy reference in `set()`.

---

## 2. Feature table

| Feature | Description | Key files | Raw | Code | Removability |
|---|---|---|---:|---:|---|
| **Signal graph** | Sources/deriveds, `get`/`set`/`untrack`, dependency tracking, derived connect/disconnect, status flags | `runtime.js`, `reactivity/{sources,deriveds,equality,status,utils}.js`, `constants.js` | 1,576 | 978 | (c) |
| **Effect tree** | Create/destroy/pause/resume effects; `$effect`, `$effect.pre`, `$effect.root`, template/render/block/branch effects | `reactivity/effects.js` | 670 | 423 | (c) |
| **Batching/scheduler** | Sync part of `Batch`, flush loop, `flushSync`, microtask queue | `reactivity/batch.js`, `dom/task.js` | 773 | 458 | (c) |
| Component instance | `push`/`pop`, `component_context`, `is_runes`, `mark_as_component` | `context.js` (part) | 89 | 55 | (c) |
| Shared utils/constants | Global aliases, `deferred`, `src/constants.js`, runtime part of `src/utils.js`, `without_reactive_context` | `shared/utils.js`, `src/constants.js`, `src/utils.js` | 362 | 196 | (c) |
| Error propagation | `handle_error`, `invoke_error_boundary` | `error-handling.js` | 85 | 56 | (c) |
| **Async / `$effect.pending` / forks / `settled`** | `async_derived`, `flatten`/blockers, `$.async` block, multi-batch time-travel/rebase/merge, `fork()`, Boundary pending members | `reactivity/async.js`, `batch.js`, `deriveds.js`, `boundary.js`, `blocks/async.js` | 1,514 | 882 | (c); `flatten`→`async_derived` path (b) |
| `$state.eager` | `eager()`, `eager_effect` | `batch.js`, `effects.js` | 81 | 49 | (a) |
| `$state` deep proxies | `proxy()` for objects/arrays | `proxy.js` | 364 | 262 | (b) |
| `$state.snapshot` | `snapshot`/`clone` | `shared/clone.js` | 139 | 85 | (a) |
| **DOM templating** | `from_html`/`from_svg`/`from_mathml`/`from_tree`, `append`, `text`, `comment`, `child`/`sibling` walkers, trusted-types HTML | `dom/template.js`, `dom/operations.js`, `dom/reconciler.js` | 693 | 402 | (c) core; variants (a) |
| `mount` / `unmount` | `_mount`, `mount`, `unmount` (excluding hydrate and delegation) | `render.js` | 157 | 90 | (c); its dependencies are (b) |
| Text updates | `set_text` | `render.js` | 15 | 7 | (a) |
| Attributes | `set_attribute`, `set_value`/`set_checked`/defaults, autofocus, form reset, `attr` | `elements/attributes.js`, `elements/misc.js`, `shared/attributes.js`, `escaping.js` | 379 | 229 | (a) |
| Spread attributes | `set_attributes`, `attribute_effect` | `elements/attributes.js` | 373 | 244 | (a) |
| `class` / `class:` | `set_class`, `clsx`, `to_class` | `elements/class.js`, `shared/attributes.js` | 103 | 66 | (a) |
| `style` / `style:` | `set_style`, `to_style` | `elements/style.js`, `shared/attributes.js` | 197 | 136 | (a) |
| Customizable `<select>` | `customizable_select`, `selectedcontent` | `elements/customizable-select.js` | 99 | 61 | (a) |
| **Hydration** | Hydration cursor, `hydrate()`, `merge_text_nodes`, `replay_events`, Boundary `#hydrate_*` members | `dom/hydration.js`, `boundary.js`, `render.js`, `attributes.js`, `events.js`, `operations.js` | 388 | 233 | (a) Rollup/Rolldown, except Boundary members (b); (b) esbuild |
| `hydratable()` | SSR→client data transfer | `hydratable.js` | 33 | 22 | (a) |
| **Event delegation** | `delegated`/`delegate`, `handle_event_propagation`, root listeners registered in `_mount` | `elements/events.js`, `render.js` | 277 | 156 | (b) |
| Non-delegated events | `create_event`, `on`, `event`, `svelte/events` | `elements/events.js`, `src/events/index.js` | 92 | 50 | (a); `create_event` calls the delegation handler |
| if/key blocks | `if_block`, `key`, `BranchManager` | `blocks/{if,key,branches}.js` | 350 | 201 | (a) |
| `{#each}` | `each`, keyed `reconcile`, animations, outro groups; keyed and unkeyed share one path | `blocks/each.js` | 778 | 503 | (a) |
| `{#await}` | `await_block` | `blocks/await.js` | 153 | 101 | (a) |
| Snippets / `{@render}` | `snippet`, `wrap_snippet`, `createRawSnippet` | `blocks/snippet.js`, `shared/validate.js` | 115 | 68 | (a) |
| Dynamic components | `component()` | `blocks/svelte-component.js` | 61 | 39 | (a) |
| `<svelte:element>` | `element()` | `blocks/svelte-element.js` | 156 | 102 | (a) |
| **`<svelte:boundary>`** | `Boundary` error/failed/reset/run, `boundary()` | `blocks/boundary.js` | 349 | 237 | (b): **always pulled in by `mount`** |
| `{@html}` | `html()` | `blocks/html.js` | 160 | 106 | (a) |
| `<svelte:head>` / `<title>` | `head()`, `deferred_template_effect` | `blocks/svelte-head.js`, `effects.js` | 83 | 52 | (a) |
| Injected CSS | `append_styles` (`css: 'injected'`) | `dom/css.js` | 38 | 23 | (a) |
| CSS custom properties | `css_props` (`--x` on components) | `blocks/css-props.js` | 28 | 19 | (a) |
| **Bindings** (see §3) | All `bind:` directives | `elements/bindings/*.js` | 1,240 | 719 | (a) |
| **Transitions runtime** | `transition()`, `animation()`, `animate()`, raf loop, `should_intro` | `elements/transitions.js`, `timing.js`, `loop.js` | 586 | 355 | (a); hooks in core (b)/(c) |
| `svelte/transition` | fade/fly/slide/scale/draw/blur/crossfade | `src/transition/index.js` | 311 | 199 | (a) |
| `svelte/animate` | `flip` | `src/animate/index.js` | 78 | 44 | (a) |
| `svelte/motion` | `Spring`/`Tween`/`spring`/`tweened`/`prefersReducedMotion` | `src/motion/*` | 714 | 411 | (a) |
| `svelte/easing` | Easing functions | `src/easing/index.js` | 348 | 127 | (a) |
| Actions (`use:`) | `action()` | `elements/actions.js` | 43 | 24 | (a) |
| Attachments (`{@attach}`) | `attach`, `createAttachmentKey`, `fromAction` | `elements/attachments.js`, `src/attachments` | 146 | 41 | (a) |
| `$store` in components | `store_get`/`store_set`/`store_unsub`, `setup_stores` | `reactivity/store.js` | 224 | 109 | (a) |
| `svelte/store` | `writable`/`readable`/`derived`/`get`/`toStore`/`fromStore` | `src/store/*` | 414 | 208 | (a) |
| **Legacy mode runtime** | `$:` (`legacy_pre_effect`), `mutable_source`/`mutate`, `deep_read*`, `beforeUpdate`/`afterUpdate`, `createEventDispatcher`, `legacy_rest_props`, `bubble_event`, `flags/legacy.js` | `props.js`, `legacy/lifecycle.js`, `runtime.js`, `index-client.js`, `legacy/misc.js`, `effects.js` | 600 | 339 | (a); ~23 unguarded core lines (b) |
| Legacy event modifiers | `once`/`preventDefault`/`self`/… | `dom/legacy/event-modifiers.js` | 127 | 62 | (a) |
| Legacy `<slot>` | `slot`, `sanitize_slots` | `blocks/slot.js` | 63 | 40 | (a) |
| `svelte/legacy` | `createClassComponent`, `asClassComponent`, `run`, `handlers`, `createBubbler` | `src/legacy/legacy-client.js` | 281 | 170 | (a) Rollup; (b) esbuild |
| Legacy component-API dev checks | `check_target`, `legacy_api` | `dev/legacy.js` | 25 | 19 | (a) |
| Context API | `createContext`/`getContext`/`setContext`/`hasContext`/`getAllContexts` | `context.js`, `shared/context.js` | 146 | 60 | (a) |
| Lifecycle | `onMount`/`onDestroy`/`tick`/`getAbortSignal` | `src/index-client.js`, `runtime.js` | 123 | 54 | (a) |
| Props | `$props`/rest/spread/`$bindable`/`$props.id` | `reactivity/props.js`, `template.js` | 371 | 245 | (a) |
| DEV: `$inspect` | `inspect`, `log_if_contains_state` | `dev/inspect.js`, `dev/console-log.js` | 111 | 72 | (a) |
| DEV: `$inspect.trace` / tag | `trace`, `tag`, `tag_proxy` | `dev/tracing.js`, `flags/tracing.js` | 167 | 97 | (a) |
| DEV: ownership | `create_ownership_validator` | `dev/ownership.js` | 81 | 46 | (a) |
| DEV: HMR | `hmr`, `cleanup_styles` | `dev/hmr.js`, `dev/css.js` | 139 | 78 | (a) |
| DEV: debug helpers | `log_effect_tree`, `log_reactions`, … | `dev/debug.js` | 516 | 326 | (a) |
| DEV: equality/assign warnings | `strict_equals`, `equals`, `assign*`, array warnings | `dev/equality.js`, `dev/assign.js`, `proxy.js` | 197 | 119 | (a) |
| DEV: misc validation | `add_locations`, `validate_*`, dev stack, error adjustments | `shared/dev.js`, `dev/elements.js`, `validate.js`, … | 477 | 287 | (a) |
| Error/warning messages | Per-message functions (289 of 533 code lines are DEV-only) | `errors.js`, `warnings.js`, `shared/{errors,warnings}.js` | 956 | 533 | (a) |
| `svelte/reactivity` | SvelteMap/Set/Date/URL/URLSearchParams, MediaQuery, ReactiveValue, `createSubscriber`, `reactivity/window` | `src/reactivity/*` | 1,370 | 758 | (a); `createSubscriber` (b), because Boundary uses it |
| Custom elements | `SvelteElement`, `create_custom_element` | `elements/custom-element.js` | 344 | 240 | (a) Rollup; (b) esbuild, because of a top-level side effect |
| Entry/barrel/flags/version | `internal/client/index.js` re-exports, `disclose-version`, `flags/index.js`, `version.js` | | 231 | 213 | (a); `disclose-version` (b) via `discloseVersion: false` |
| **Client total** | | | **21,159** | **12,586** | |

**How lines were attributed:**
- Each line belongs to exactly one feature. The most specific selector wins: explicit line range, then class member, then top-level declaration, then whole file.
- A guarded branch inside a function, such as `if (hydrating)` inside `child()`, is counted under its host function's feature above. It is counted *again* as cross-cutting code in §5, so the §5 numbers overlap this table by design.

---

## 3. Sub-breakdowns

### Bindings (719 code lines)

| Group | Functions | Code LOC |
|---|---|---:|
| input | `bind_value`, `bind_checked`, `bind_group`, `bind_files` | 182 |
| select | `bind_select_value`, `init_select`, `select_option`, … (also emitted for a plain `<select value>`) | 145 |
| media | 11 `bind_*` functions | 130 |
| size | ResizeObserver singletons, `bind_resize_observer`, `bind_element_size` | 66 |
| window / document / navigator | `bind_window_scroll`/`size`, `bind_active_element`, `bind_online` | 58 |
| this | `bind_this` | 51 |
| universal | `bind_content_editable`, `bind_property`, `bind_focused` | 41 |
| shared | `listen`, `listen_to_event_and_reset_event` | 35 |
| prop | `bind_prop` (component exports) | 11 |

### `blocks/each.js` (503 code lines)

| Concern | Code LOC |
|---|---:|
| Core reconcile | ~343 |
| Transitions/animations: `pause_effects`, outro groups, `EACH_IS_ANIMATED` measure/fix/apply | 82 |
| Async multi-batch: pending map, defer/skip/oncommit/ondiscard | 34 |
| Hydration | 27 |
| DEV | 17 |

`mutable_source` is referenced by `each.js` in all modes, which is 10 lines of dead weight in runes mode.

### `blocks/branches.js` (`BranchManager`, 133 code lines)

| Concern | Code LOC |
|---|---:|
| Async offscreen/multi-batch bookkeeping (upper bound) | 65 |
| Sync core | ~50 |
| Transitions | 12 |
| Hydration | 3 |
| DEV | 3 |

---

## 4. What a Hello World actually ships

The Hello World component:

```svelte
<script>let name = $state('world');</script>
<h1>Hello {name}!</h1>
```

The compiler inlines the never-reassigned `$state`, so the component only calls `$.from_html` and `$.append`, plus the `disclose-version` side-effect import. The entry point adds `mount`. Even so, the bundle contains 25 to 31 runtime modules:

```
mount (render.js)
 ├─ init_operations/create_text ...... dom/operations.js
 ├─ component_root ................... effects.js → batch.js (whole Batch class) → task.js
 │                                     runtime.js (update_effect/get → deriveds.js) → error-handling.js
 ├─ boundary() [UNCONDITIONAL] ....... boundary.js (incl. #hydrate_* + $effect.pending members)
 │    └─ #effect_pending_subscriber .. create-subscriber.js → sources.js (set → internal_set → mark_reactions)
 │                                         └─ set(): should_proxy ? proxy() [UNCONDITIONAL] → proxy.js
 ├─ push/pop ......................... context.js
 └─ delegation [UNCONDITIONAL] ....... events.js (handle_event_propagation)
App: from_html/append → template.js → reconciler.js (trusted-types policy)
App: disclose-version.js → version.js   [top-level side effect]
misc: constants.js, shared/utils.js, errors.js, warnings.js, status/utils/equality, flags/index.js
```

Some modules are shipped only because a core function references them unconditionally:

| What | Why it's included | Verified |
|---|---|---|
| `boundary.js`, `create-subscriber.js`, most of `sources.js` | `_mount` always wraps the root in `boundary()` | `render.js:175` |
| `proxy.js` | `set()` does `should_proxy ? proxy(value) : value` | `sources.js:162` |
| `events.js` delegation | `_mount` registers root listeners for all delegated events | |
| Async `Batch` members | Class methods can't be tree-shaken | |
| `async_derived`, `capture`, `increment_pending` | `template_effect → flatten` has an async slow path (reactive variant only) | |

### Measured sizes

Rollup + terser `passes: 2`, production. "Reactive" is the Hello World plus `<button onclick={() => name += '!'}>`.

| Case | Min B | Gzip B |
|---|---:|---:|
| Hello, `mount` (Rollup) | 23,709 | 9,152 |
| Hello (Rolldown) | 23,816 | 9,189 |
| Hello (esbuild) | 34,034 | 12,942 |
| Hello, `hydrate` instead of `mount` | 25,135 | 9,731 |
| Hello − root boundary | 15,456 | 6,395 |
| Hello − delegation | 22,371 | 8,591 |
| Hello − `proxy` in `set()` | 21,375 | 8,322 |
| **Hello − boundary − delegation − proxy** | **14,137 (−40%)** | **5,839 (−36%)** |
| Reactive, `mount` | 26,053 | 10,086 |
| Reactive − root boundary | 22,402 | 8,963 |
| Reactive − async path of `flatten` | 24,458 | 9,480 |
| Reactive − `proxy` in `set()` | 23,833 | 9,240 |
| **Reactive − boundary − async `flatten` − proxy** | **18,552 (−28.8%)** | **7,550 (−25%)** |
| Kitchen sink, `mount` | 44,121 | 16,896 |
| Kitchen sink, `hydrate` | 48,000 | 18,273 |
| Kitchen sink (esbuild) | 61,886 | 23,260 |

The kitchen sink uses if/each/await/key/snippet/html/element/component/head/bind/spread/boundary.

### Share of the reactive bundle (26,053 B min) by feature

| Feature | Approx. bytes | Share |
|---|---:|---:|
| Signal graph | 6,916 | 26.5% |
| **Async (unused, `experimental.async` off)** | **4,578** | **17.6%** |
| Batch core | 3,038 | 11.7% |
| Effects | 2,549 | 9.8% |
| Proxy | 1,696 | 6.5% |
| Boundary (error part) | 1,576 | 6.1% |
| Templating | 1,186 | 4.6% |
| Delegation (plus `_mount` part) | 916+ | 3.5% |
| Mount | 773 | 3.0% |
| Messages | 525 | 2.0% |
| Hydration (Boundary members) | 507 | 1.9% |

The async share breaks down as `Batch` members ~2.5 KB, `async.js` ~0.8 KB, `async_derived` ~0.7 KB and Boundary pending members ~0.5 KB.

---

## 5. Cross-cutting code inside core files

Some features are written as branches inside functions every app uses, rather than living in their own module. Tree-shaking can't drop that code, but a compile-time constant can. What matters is whether each guard can be constant-folded.

### Guards

| Guard | Kind | Rollup / Rolldown | esbuild | Removal technique |
|---|---|---|---|---|
| `DEV` (esm-env) | Constant via the `production` export condition | Folded | Folded | Already handled by `conditions` |
| `hydrating` (`dom/hydration.js`) | Mutable `export let`, set by `set_hydrating()` | Folded if `hydrate()` is unreachable | **Not folded** | Rewrite to `__HYDRATION__ && hydrating` plus a `define`, or turn it into a constant |
| `legacy_mode_flag` (`flags/index.js`) | Mutable `export let`, set by the `svelte/internal/flags/legacy` side-effect import | Folded if there is no legacy component | **Not folded** | Same as `hydrating` |
| `is_runes()` | `!legacy_mode_flag \|\| component_context.l === null` | Becomes `return true` | No | Follows `legacy_mode_flag` |
| `async_mode_flag` / `should_defer_append()` | Mutable `export let`, set by `svelte/internal/flags/async` | Folded if there is no async component | **Not folded** | Same as `hydrating` |
| `batch.is_fork` | Runtime field (26 refs in 5 files) | No | No | Code removal |
| `tracing_mode_flag` | Mutable `let`, always paired with `DEV &&` | 0 prod lines | 0 prod lines | Nothing to do |
| Transitions | No guard: runtime data (`effect.nodes.t`, `EACH_IS_ANIMATED`, `EFFECT_TRANSPARENT`) | No | No | Needs a new flag |
| Event delegation | No guard: wired unconditionally in `_mount` | No | No | New flag or lazy registration |
| Root boundary | No guard: `_mount` always calls `boundary()` | No | No | New flag, or apply it only when `transformError` is passed |

With esbuild, rewriting the flag reads to `__SVELTE_HYDRATION__ / __LEGACY__ / __ASYNC__ && flag` plus `define` saved **1,551 B min / 530 B gz** on the Hello World.

Guard reference counts:

| Guard | References |
|---|---|
| `DEV` | 157 in 42 files |
| `hydrating` | 83 in 28 files |
| `hydrate_node` | 52 in 15 files |
| `async_mode_flag` | 14 in 9 files |
| `tracing_mode_flag` | 7 |
| `is_runes` | 7 |
| `legacy_mode_flag` | 5 |

### Always-included core files

These are the 25 modules in the minimal bundle, 5,063 code lines. 3,123 of those lines survive tree-shaking in the reactive Hello World (counted before constant folding).

Each concern cell reads **total in file | g guarded + u unguarded**:
- **g** is guarded code that ships but gets folded away by Rollup/Rolldown.
- **u** is unguarded code that ships in every app, whatever the bundler.

| File | Code | Shipped | DEV | Hydration | Legacy | Async | Transitions | Delegation |
|---|---:|---:|---:|---|---|---|---|---|
| `runtime.js` | 555 | 426 | 59 | 0 | 54 \| 0g+1u | 13 \| 0g+4u | 0 | 0 |
| `reactivity/sources.js` | 240 | 164 | 30 | 0 | 24 \| 1g+6u | 0 | 0 | 0 |
| `reactivity/deriveds.js` | 299 | 237 | 53 | 0 | 0 | 92 \| 0g+87u | 0 | 0 |
| `reactivity/effects.js` | 467 | 290 | 27 | 0 | 33 \| 0 | 4 \| 0g+4u | 42 \| 0g+33u | 0 |
| `reactivity/batch.js` | 862 | 686 | 40 | 0 | 13 \| 0g+13u | **428 \| 32g+333u** | 0 | 0 |
| `reactivity/async.js` | 249 | 103 | 20 | 0 | 0 | 229 \| 0g+83u | 0 | 0 |
| `context.js` | 112 | 46 | 31 | 0 | 3 \| 0g+3u | 10 \| 0 | 0 | 0 |
| `proxy.js` | 306 | 232 | 68 | 0 | 0 | 0 | 0 | 0 |
| `dom/template.js` | 248 | 47 | 0 | 44 \| 12g+0u | 0 | 0 | 0 | 0 |
| `dom/operations.js` | 169 | 100 | 4 | 53 \| 28g+0u | 0 | 6 \| 0 | 0 | 0 |
| `render.js` | 187 | 103 | 3 | 58 \| 14g+0u | 0 | 0 | 7 \| 0g+3u | **43 \| 0g+43u** |
| `dom/elements/events.js` | 207 | 101 | 30 | 14 \| 0 | 0 | 0 | 0 | **104 \| 0g+101u** |
| `dom/blocks/boundary.js` | 374 | 324 | 3 | **81 \| 22g+59u** | 0 | **90 \| 8g+72u** | 0 | 0 |
| `error-handling.js` | 86 | 43 | 39 | 0 | 0 | 0 | 0 | 0 |
| `errors.js` | 265 | 54 | 147 | 0 | 0 | 0 | 0 | 0 |
| `warnings.js` | 161 | 14 | 78 | 0 | 0 | 0 | 0 | 0 |
| `reactivity/create-subscriber.js` | 35 | 29 | 3 | 0 | 0 | 0 | 0 | 0 |
| 8 small files (task, constants, status, equality, utils, reconciler, …) | 241 | 124 | 0 | 0 | 0 | 0 | 0 | 0 |
| **Total** | **5,063** | **3,123** | **635** | **250 \| 76g+59u** | **127 \| 1g+23u** | **872 \| 40g+583u** | **49 \| 0g+36u** | **147 \| 0g+144u** |

Notable items in this table:
- **Async (583 unguarded shipped lines)** is the biggest single target. It sits in `Batch` members: `#commit` (84 lines), `#merge` (41), `#is_deferred`, `#find_earlier_batch`, `skip_effect`/`unskip_effect`, `increment`/`decrement`, and `register_created_effect`, which is called for *every* effect. It also sits in `async_derived` and in the Boundary pending members.
- **Hydration.** The Boundary `#hydrate_*` members (59 lines, ~0.5 KB) ship even in mount-only builds. The rest of the hydration code folds away in Rollup, but it is kept by any bundler that can't fold `hydrating`.
- **Legacy.** `legacy_updates` plumbing in `Batch.#process` and `mark_reactions` is active even in runes mode (19 lines).
- **Transitions.** Hooks in `destroy_effect`, `pause_effect`, `pause_children`/`resume_children` and `should_intro`.

### Cross-cutting totals across all client code (non-DEV)

| Concern | Code LOC |
|---|---:|
| Async | 1,016 |
| Hydration | 562 |
| Legacy | 367 |
| Delegation | 147 |
| Transition hooks outside `transitions.js` | 143 (`each.js` 82, `effects.js` 42, `branches.js` 12, `render.js` 7) |

---

## 6. Candidates for a minimal build

Ranked by estimated savings on the Hello World or reactive Hello World (Rollup numbers; Bun numbers are in `BASELINE.md`):

| # | Cut | Technique | Est. savings (min) | Risk / what you lose |
|---|---|---|---:|---|
| 1 | **Root `<svelte:boundary>` in `mount`** | Flag or patch `_mount` to skip `boundary()` | −8.25 KB hello / −3.65 KB reactive | Lose `transformError` and root-level error handling/pending UI; user `<svelte:boundary>` still works |
| 2 | **Async machinery** (`experimental.async`, `$effect.pending`, `fork`, `settled`) | Flag the `flatten` slow path; stub/strip async `Batch`/Boundary members | −1.6 KB (flatten only); up to ~4.6 KB total | Can't use `await` in templates or scripts, `$effect.pending`, or `fork` |
| 3 | **Deep `$state` proxies** | Drop the `proxy()` ref in `set()` (compiler already knows when to proxy) | −2.2 to −2.3 KB | Objects/arrays assigned to `$state` are no longer deeply reactive (or need a compiler change) |
| 4 | **Hydration** | Make `hydrating` a `define`-able constant; strip Boundary `#hydrate_*` | ~1.5 KB on esbuild-style bundlers; ~0.5 KB on Rollup | No SSR hydration (`hydrate()`) |
| 5 | **Event delegation** | Register root listeners lazily or not at all | −1.3 KB | `onclick` etc. would need `addEventListener` per element |
| 6 | **Legacy mode** | Make `legacy_mode_flag` a constant `false`; strip `legacy_updates` | ~0.2 to 0.4 KB | No Svelte 4 components (`$:`, `export let`, `createEventDispatcher`, `<slot>`) |
| 7 | **Transitions** | New flag gating hooks in `effects.js`/`each.js`/`branches.js` | 143 code lines (bytes TBD) | No `transition:`/`in:`/`out:`/`animate:` |
| 8 | `disclose-version` | Compile option `discloseVersion: false` | ~124 B | Nothing functional |
| 9 | Custom-element side effect | Wrap the top-level `if (typeof HTMLElement…)` in a PURE IIFE | Large on esbuild (keeps `svelte/legacy` + `hydrate()`) | Nothing, if custom elements are unused |

Everything else (bindings, each/await/html/etc. blocks, stores, motion, `svelte/reactivity`, DEV code, messages) is **already tree-shaken** when unused. Dropping it from a "lite" build saves nothing on bundle size, though it would shrink the API surface.

---

## 7. Method and reproduction

- **Counting.** Raw = physical lines. Code = lines containing at least one JS token (acorn tokenizer), which matches `cloc` exactly for the covered files.
- **Guard folding.** An AST pass folds each guard to its "feature off" value and counts dead branches, dead `&&`/`||` operands, and code after early returns. The folded values are:
  - `hydrating = false`, `legacy_mode_flag = false`, `async_mode_flag = false`, `tracing_mode_flag = false`, `DEV = false`
  - `is_runes() = true`, `component_context.l = null`
  - `should_defer_append() = false`, `.is_fork = false`
- **Unguarded code.** Transitions, delegation, async members and `legacy_updates` were identified by hand-verified line ranges.
- **Batch/Boundary members** count as "async" when they are only reachable with `experimental.async` or `fork()`.
- **Tools:** Rollup 4.62.2 and esbuild 0.28.1 from the Svelte repo, Rolldown 1.2.11, terser 5.27.0.
- **Scripts:** in the session scratchpad.

| Script | Purpose |
|---|---|
| `features.mjs`, `compute.mjs` | Feature map |
| `guards.mjs` | Guard folding |
| `crosscut*.mjs` | Cross-cutting tables |
| `exp.mjs`, `run2`–`run8.mjs` | Bundler experiments |
| `why.mjs` | Module graph |

## 8. Server runtime (for reference)

`src/internal/server/**` has 13 files; with the server entry points it is 18 files, **2,653 raw / 1,460 code lines**:

| File | Code LOC |
|---|---:|
| `renderer.js` | 628 |
| `index.js` | 308 |
| `hydratable.js` | 85 |
| `dev.js` | 67 |
| `errors.js` | 55 |
| `context.js` | 49 |
| `render-context.js` | 48 |
| `crypto.js` | 23 |
| Others | 47 |

The server entry points are `index-server.js`, `server/index.js`, `store/index-server.js`, `reactivity/index-server.js` and `legacy/legacy-server.js`. None of the server runtime is reachable from client bundles.
