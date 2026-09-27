# VITE: Bun.build() vs Vite

The same variants and apps, bundled two ways: `build.ts` uses Bun 1.4.2's `Bun.build()`, and `build-vite.ts` uses Vite 8 (Rolldown with the Oxc minifier). Both go through the same checks and measurement, so any size difference comes from the bundler.

## Setup

**Shared by both pipelines:**

- **Svelte source.** Both resolve it through `scripts/link-svelte.ts`. The stamp under the generated marker names the ref each side was built from.
- **Patches.** `plugins/vite.ts` loads runtime modules through the same `loadPatched()` → `applyPatches()` as the Bun plugin. That covers every patch, anchor check, hash pin and `constImports` rule.
- **Compilation.** Both use the same `compileSvelte()`: the same compiler options, `namedImports`, `proxySet` rewrite and build-time bans.
- **SSR and the behavioural check.** SSR uses the same `htmlPage()`, and the SSR HTML is byte-identical on both sides apart from the `<title>`. The same `check.ts` harness runs SSR HTML → `hydrate()` → `apps/<app>/test.ts` on `main.min.js`, `main.js` and `main.readable.js`, plus the mismatch-recovery run. Every Vite build passes it.
- **Measurement.** Both use the same `measure.ts`: `main.min.js` raw, gzip -9 and brotli q11.

**Vite's own production defaults, as a Vite user gets them:**

- export conditions `module`, `browser`, `production`
- `process.env.NODE_ENV`
- `build.target` (`baseline-widely-available`)
- `build.minify: 'oxc'`

**Not applied under Vite:**

- `optimizeImports`: Bun's barrel optimisation. Rolldown drops unused re-exports on its own.
- `postpass`: it re-bundles with Bun.

So Vite's `optimized` is the same patch set without the post-pass. A variant that uses `plugins`, `features` or `drop` fails the Vite build, because those are Bun-only; none does today.

**Per-module attribution.** Oxc's compress pass merges `var` lists across modules and drops Rolldown's `//#region` comments. So `build-vite.ts` recovers module boundaries in `main.readable.js` from the unminified `main.js`, where the names are the same and the regions intact. A merged `var` list counts toward the module with the most bytes in it: for example, `render.js`'s `mounted_components` shares a statement with `branches.js`'s `BranchManager` class. Per-module rows for Vite can therefore be off by a few small declarations. The totals are exact.

## How to run

```sh
bun run build.ts --all --svelte=main          # Bun  -> dist/<variant>/<app>/
bun run build-vite.ts --all --svelte=main     # Vite -> dist-vite/<variant>/<app>/ (about 0.1 s of bundling per app, plus the checks)
bun run comparison:vite                       # regenerate the tables below
bun run check.ts --out=dist-vite              # re-run the behavioural checks on the Vite builds
```

Build both sides from the same Svelte ref. `--svelte=main` is needed for `minimal` for now (see CLAUDE.md, "Known state"). If the two sides differ, the generated section warns.

## What the numbers say

These notes are from upstream `main` @ `f90853565966`, Bun 1.4.2 and Vite 8.3.1 (Rolldown 1.2.11), across the four apps built on both sides.

- **Vanilla Svelte: Vite is 35–42% smaller raw and 32–39% smaller gzip.** The per-module table shows where Bun loses. It is the dead code that BASELINE.md and CLAUDE.md describe:
  - `custom-element.js`: 2.5 KB. A top-level side effect keeps it, and with it `legacy-client.js`.
  - `errors.js`/`warnings.js`: DEV branches that aren't folded.
  - `batch.js`: unfolded flags and class members.
  - `dev/equality.js`, `shared/dev.js` and other dev-only code.
- **`optimized` mostly makes up for Bun.** It saves 5.1–6.0 KB gzip under Bun but only 210–233 B under Vite. In other words, the lossless fixes are Bun workarounds, and under Vite `optimized` ≈ `baseline`.
- **The feature drops are real savings under both bundlers.** Every step from `m1` to `minimal` saves about the same under each. The async step is the largest (−3.9/−2.9 KB gzip under Bun, −3.1/−2.1 KB under Vite, `hello`/`reactive`).
- **`minimal`: Vite is still 6–7% smaller raw and 4–5% smaller gzip.** Almost the same functions ship; the gap is spread thinly across modules. Most of it is 20–30 exported constants: effect flags, hydration markers and node types, such as `DERIVED`, `BRANCH_EFFECT` and `HYDRATION_START`. Oxc inlines them. Bun keeps each as a top-level `var`, because it never carries a constant across modules. The rest is Oxc's tighter minification inside functions.

## Matching Vite's baseline with Bun: `baseline-bun`

`baseline-bun` is Bun's closest lossless build to Vite's plain `baseline`. It is `optimized` plus the post-pass's minify steps (the `MINIFY` technique, `postpass-minify.ts`). It keeps every feature, and it lands within 0.3–2.0% of Vite gzipped and 2.9–3.7% raw. See the table below.

**How the gap was found.** The test was to swap minifiers between the two pipelines:

- Bun's `optimized` bundle, minified by Oxc, is already as small as Vite's baseline: 24,087 B vs 24,050 B on `hello`, and smaller gzipped. So after `optimized`, Bun's tree-shaking keeps no more code than Rolldown's.
- The whole remaining gap is Bun's minifier vs Oxc's. Rolldown's bundle minified by Bun is 32.9 KB.

**What the minify steps add.** Each step is a rewrite Oxc does and Bun 1.4.2 doesn't, and each is lossless by construction:

- **Constant propagation** (−1.9 to −2.1 KB raw, −0.8 to −1.0 KB gzip). A top-level binding that holds a literal and is never written anywhere in the bundle is inlined.
  - This covers Svelte's effect flags, hydration markers and node types.
  - It also covers `async_mode_flag`/`legacy_mode_flag`, whose setters are tree-shaken. Their folding takes the async and legacy paths out of `Batch`, `Boundary` and the runtime. For example, `Batch.apply()` shrinks from 587 to 27 B, and `#commit`, `mark_effects` and `depends_on` then go.
  - Bun emits module-level `const` as `var`, so a read before the declaration runs would see `undefined`. A binding is therefore only inlined if no code that runs before its declaration can reach it.
- **Bit-flag tests** (about −300 B raw, −30 B gzip). `(f & N) !== 0` becomes `f & N` wherever only truthiness counts. There are 64–85 of these per bundle.
- **Constant comma-expression tests** (about −25 B). `if (a, !1) …` is left over from DEV-only blocks that declare a `var`.

**What's left, and why it stops here.** On `hello`, about 0.6 KB of the remaining raw gap is Oxc's code generation and statement merging, and about 0.5 KB is its compressor turning statements into expressions. Examples: `if (a) b()` → `a && b()`, `if/else` → `?:`, `if (a) return x; return y` → `return a ? x : y`, and inlining single-use locals.

I prototyped the first two as a post-pass step. It saved 1.5% raw but *added* 42–67 B gzip on every app, because `if(` repeats often enough to compress better. So it isn't included. The rest amounts to re-implementing a minifier.

**Not applied to `optimized`/`minimal` yet.** The same steps would take `minimal` down by 330–440 B raw and 177–235 B gzip (2–4%). Whether to fold them into `optimized`, and so into every variant, is an open decision. It would also change the numbers in COMPARISON.md.

**Test coverage.** The minify steps run on the bundle, so `bun run test:svelte`, which patches Svelte's source, doesn't exercise them. They are covered by the behavioural checks on `main.min.js` and `main.readable.js` of every app, including the mismatch-recovery runs. That is the same coverage the post-pass's dead-code steps have.

<!-- generated by scripts/vite-comparison.ts; do not edit below this line by hand -->

- **Bun:** Bun 1.4.2; Svelte 5.57.1 (main, f90853565966, https://github.com/sveltejs/svelte.git)
- **Vite:** Vite 8.3.1 (Rolldown 1.2.11); Svelte 5.57.1 (main, f90853565966, https://github.com/sveltejs/svelte.git)

## Sizes: Bun vs Vite (`main.min.js`)

Δ is Vite minus Bun: negative means Vite's bundle is smaller.

| app | variant | Bun raw | Vite raw | Δ raw | Bun gzip | Vite gzip | Δ gzip | Bun brotli | Vite brotli | Δ brotli |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hello | baseline | 41,544 | 24,050 | −17,494 (−42.1%) | 15,542 | 9,560 | −5,982 (−38.5%) | 13,977 | 8,680 | −5,297 (−37.9%) |
| hello | optimized | 27,059 | 23,640 | −3,419 (−12.6%) | 10,428 | 9,327 | −1,101 (−10.6%) | 9,429 | 8,496 | −933 (−9.9%) |
| hello | **minimal** | 11,436 | 10,683 | −753 (−6.6%) | 4,953 | 4,724 | −229 (−4.6%) | 4,489 | 4,284 | −205 (−4.6%) |
| reactive | baseline | 61,138 | 39,595 | −21,543 (−35.2%) | 22,801 | 15,532 | −7,269 (−31.9%) | 20,470 | 14,043 | −6,427 (−31.4%) |
| reactive | optimized | 43,605 | 39,226 | −4,379 (−10.0%) | 16,846 | 15,322 | −1,524 (−9.0%) | 15,171 | 13,904 | −1,267 (−8.4%) |
| reactive | **minimal** | 31,281 | 29,356 | −1,925 (−6.2%) | 12,776 | 12,221 | −555 (−4.3%) | 11,571 | 11,028 | −543 (−4.7%) |
| boundary | baseline | 48,850 | 29,998 | −18,852 (−38.6%) | 18,172 | 11,653 | −6,519 (−35.9%) | 16,327 | 10,547 | −5,780 (−35.4%) |
| boundary | optimized | 33,270 | 29,592 | −3,678 (−11.1%) | 12,683 | 11,422 | −1,261 (−9.9%) | 11,461 | 10,358 | −1,103 (−9.6%) |
| boundary | **minimal** | 23,993 | 22,519 | −1,474 (−6.1%) | 9,669 | 9,183 | −486 (−5.0%) | 8,723 | 8,315 | −408 (−4.7%) |
| stores | baseline | 54,540 | 33,983 | −20,557 (−37.7%) | 20,310 | 13,323 | −6,987 (−34.4%) | 18,239 | 12,057 | −6,182 (−33.9%) |
| stores | optimized | 37,565 | 33,577 | −3,988 (−10.6%) | 14,458 | 13,092 | −1,366 (−9.4%) | 13,080 | 11,881 | −1,199 (−9.2%) |
| stores | **minimal** | 23,668 | 22,129 | −1,539 (−6.5%) | 9,781 | 9,322 | −459 (−4.7%) | 8,809 | 8,431 | −378 (−4.3%) |

## Bun's closest lossless build: `baseline-bun` vs Vite's `baseline`

Every build in this table keeps all of Svelte's features. `baseline-bun` is `optimized` plus the post-pass's minify steps (postpass-minify.ts). Δ is `baseline-bun` minus Vite's `baseline`.

| app | Vite baseline raw / gzip | Bun baseline | Bun optimized | Bun baseline-bun | Δ raw | Δ gzip | Δ brotli |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hello | 24,050 / 9,560 | 41,544 / 15,542 | 27,059 / 10,428 | **24,748 / 9,584** | +698 (+2.9%) | +24 (+0.3%) | −6 (−0.1%) |
| reactive | 39,595 / 15,532 | 61,138 / 22,801 | 43,605 / 16,846 | **41,068 / 15,847** | +1,473 (+3.7%) | +315 (+2.0%) | +279 (+2.0%) |
| boundary | 29,998 / 11,653 | 48,850 / 18,172 | 33,270 / 12,683 | **30,914 / 11,810** | +916 (+3.1%) | +157 (+1.3%) | +187 (+1.8%) |
| stores | 33,983 / 13,323 | 54,540 / 20,310 | 37,565 / 14,458 | **35,115 / 13,542** | +1,132 (+3.3%) | +219 (+1.6%) | +214 (+1.8%) |

## Stacking under each bundler (gzip)

The variants of COMPARISON.md's stacking table, built by each bundler. Δ is the saving of that step over the row above, for that bundler.

| variant | hello Bun | Δ | hello Vite | Δ | reactive Bun | Δ | reactive Vite | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `baseline` | 15,542 |  | 9,560 |  | 22,801 |  | 15,532 |  |
| `optimized` | 10,428 | −5,114 | 9,327 | −233 | 16,846 | −5,955 | 15,322 | −210 |
| `m1-legacy` | 10,354 | −74 | 9,280 | −47 | 16,751 | −95 | 15,294 | −28 |
| `m2-async` | 6,493 | −3,861 | 6,187 | −3,093 | 13,854 | −2,897 | 13,226 | −2,068 |
| `m3-transitions` | 6,396 | −97 | 6,084 | −103 | 13,406 | −448 | 12,805 | −421 |
| `m4-boundary` | 5,518 | −878 | 5,251 | −833 | 12,753 | −653 | 12,184 | −621 |
| `m5-delegation` | 4,953 | −565 | 4,724 | −527 | 12,786 | +33 | 12,222 | +38 |
| `minimal` | 4,953 | 0 | 4,724 | 0 | 12,776 | −10 | 12,221 | −1 |
| `minimal+strict-hydration` | 4,850 | −103 | 4,620 | −104 | 12,689 | −87 | 12,129 | −92 |
| `minimal+strict-hydration+short-errors` | 4,863 | +13 | 4,637 | +17 | 12,693 | +4 | 12,125 | −4 |

## Where the bytes differ: per module (`min` bytes)

Bytes of `main.min.js` attributed to each source module (measure.ts, from the top-level statements of the aligned readable/minified builds), largest difference first. Modules within 50 B of each other are summed into the last row.

### hello / baseline: Bun 41,544 B, Vite 24,050 B (−17,494)

| module | Bun | Vite | Δ |
| --- | ---: | ---: | ---: |
| `internal/client/reactivity/batch.js` | 7,432 | 4,791 | −2,641 |
| `internal/client/dom/elements/custom-element.js` | 2,525 | 0 | −2,525 |
| `internal/client/errors.js` | 2,292 | 444 | −1,848 |
| `internal/client/warnings.js` | 1,895 | 214 | −1,681 |
| `legacy/legacy-client.js` | 1,030 | 0 | −1,030 |
| `internal/client/proxy.js` | 2,890 | 1,910 | −980 |
| `utils.js` | 903 | 71 | −832 |
| `internal/client/reactivity/sources.js` | 1,787 | 1,080 | −707 |
| `internal/client/dev/equality.js` | 662 | 0 | −662 |
| `internal/shared/dev.js` | 626 | 0 | −626 |
| `internal/client/runtime.js` | 3,872 | 3,256 | −616 |
| `internal/client/error-handling.js` | 867 | 280 | −587 |
| `internal/shared/errors.js` | 411 | 0 | −411 |
| `internal/client/reactivity/effects.js` | 2,692 | 2,392 | −300 |
| `internal/client/constants.js` | 673 | 393 | −280 |
| `index-client.js` | 243 | 0 | −243 |
| `internal/client/reactivity/deriveds.js` | 952 | 751 | −201 |
| `internal/client/dom/blocks/boundary.js` | 3,351 | 3,182 | −169 |
| `internal/client/context.js` | 452 | 288 | −164 |
| `internal/client/reactivity/equality.js` | 162 | 33 | −129 |
| `constants.js` | 157 | 35 | −122 |
| `internal/client/render.js` | 1,512 | 1,409 | −103 |
| `internal/client/dev/tracing.js` | 96 | 0 | −96 |
| `internal/client/dom/elements/attributes.js` | 94 | 0 | −94 |
| `internal/disclose-version.js` | 66 | 0 | −66 |
| 20 other modules | 3,901 | 3,521 | −380 |

### hello / minimal: Bun 11,436 B, Vite 10,683 B (−753)

| module | Bun | Vite | Δ |
| --- | ---: | ---: | ---: |
| `internal/client/reactivity/batch.js` | 2,319 | 2,125 | −194 |
| `internal/client/runtime.js` | 2,077 | 1,896 | −181 |
| `constants.js` | 94 | 0 | −94 |
| `internal/client/reactivity/effects.js` | 1,749 | 1,666 | −83 |
| 20 other modules | 5,196 | 4,996 | −200 |

### reactive / baseline: Bun 61,138 B, Vite 39,595 B (−21,543)

| module | Bun | Vite | Δ |
| --- | ---: | ---: | ---: |
| `internal/client/errors.js` | 3,869 | 589 | −3,280 |
| `internal/client/dom/elements/custom-element.js` | 2,526 | 0 | −2,526 |
| `internal/client/reactivity/batch.js` | 7,443 | 4,942 | −2,501 |
| `internal/client/warnings.js` | 2,585 | 214 | −2,371 |
| `legacy/legacy-client.js` | 1,030 | 0 | −1,030 |
| `internal/client/proxy.js` | 2,884 | 1,914 | −970 |
| `utils.js` | 903 | 71 | −832 |
| `internal/client/runtime.js` | 4,015 | 3,319 | −696 |
| `internal/client/reactivity/deriveds.js` | 2,360 | 1,678 | −682 |
| `internal/client/dev/equality.js` | 662 | 0 | −662 |
| `internal/client/reactivity/sources.js` | 1,853 | 1,217 | −636 |
| `internal/shared/dev.js` | 626 | 0 | −626 |
| `internal/client/dom/elements/attributes.js` | 1,505 | 899 | −606 |
| `internal/client/dom/blocks/each.js` | 4,470 | 3,876 | −594 |
| `internal/client/error-handling.js` | 867 | 281 | −586 |
| `internal/shared/errors.js` | 411 | 0 | −411 |
| `internal/client/reactivity/effects.js` | 3,187 | 2,845 | −342 |
| `internal/client/reactivity/async.js` | 1,052 | 803 | −249 |
| `index-client.js` | 243 | 0 | −243 |
| `constants.js` | 187 | 0 | −187 |
| `internal/client/render.js` | 1,618 | 1,441 | −177 |
| `internal/client/dom/blocks/boundary.js` | 3,345 | 3,180 | −165 |
| `internal/client/context.js` | 452 | 288 | −164 |
| `internal/client/constants.js` | 689 | 562 | −127 |
| `internal/client/dom/operations.js` | 1,506 | 1,388 | −118 |
| `internal/client/dev/tracing.js` | 97 | 0 | −97 |
| `internal/shared/attributes.js` | 1,342 | 1,264 | −78 |
| `internal/disclose-version.js` | 66 | 0 | −66 |
| `apps/reactive/App.svelte` | 1,919 | 1,854 | −65 |
| `internal/client/dom/blocks/branches.js` | 1,453 | 1,396 | −57 |
| 25 other modules | 5,972 | 5,574 | −398 |

### reactive / minimal: Bun 31,281 B, Vite 29,356 B (−1,925)

| module | Bun | Vite | Δ |
| --- | ---: | ---: | ---: |
| `internal/client/runtime.js` | 3,300 | 3,018 | −282 |
| `internal/client/dom/blocks/each.js` | 3,034 | 2,821 | −213 |
| `internal/client/reactivity/batch.js` | 2,471 | 2,288 | −183 |
| `internal/client/reactivity/effects.js` | 2,550 | 2,374 | −176 |
| `internal/client/proxy.js` | 2,035 | 1,909 | −126 |
| `constants.js` | 123 | 0 | −123 |
| `internal/client/reactivity/sources.js` | 1,279 | 1,161 | −118 |
| `internal/client/dom/elements/attributes.js` | 997 | 900 | −97 |
| `internal/shared/attributes.js` | 1,350 | 1,264 | −86 |
| `internal/client/constants.js` | 619 | 553 | −66 |
| `internal/client/reactivity/deriveds.js` | 1,018 | 967 | −51 |
| 28 other modules | 12,504 | 12,101 | −403 |

