# svelte-lite

A slimmed-down build of the Svelte 5 client runtime for SSR + `hydrate()` apps, bundled with Bun. The official Svelte source is vendored, not forked. Every change is a documented patch applied at build time.

On the test apps, gzipped `main.min.js`:

| app | baseline | optimized (lossless) | minimal |
| --- | ---: | ---: | ---: |
| Hello World | 15,542 B | 10,575 B (−32%) | 5,098 B (−67%) |
| reactive app | 22,801 B | 17,117 B (−25%) | 13,010 B (−43%) |

`minimal` drops:
- legacy (Svelte 4) mode
- async
- transitions and animations
- the root boundary in `hydrate()`

## Usage

```sh
bun install
bun run vendor 5.57.1          # or: main, svelte@5.57.1, <commit sha>
bun run build.ts minimal       # also: baseline, optimized, --all
bun run check.ts               # behavioural checks, patch anchors, negative tests
bun run test:svelte minimal    # Svelte's own test suite against the patched runtime
```

`minimal` currently needs `--svelte=main`. See the "Known state" section in [CLAUDE.md](CLAUDE.md).

## Docs

| File | Contents |
| --- | --- |
| [COMPARISON.md](COMPARISON.md) | Sizes, and savings per feature |
| [PATCHES.md](PATCHES.md) | Every patch and why it exists |
| [SVELTE_TESTS.md](SVELTE_TESTS.md) | Results of Svelte's official test suite |
| [FEATURE_REPORT.md](FEATURE_REPORT.md) | Runtime feature and LOC map |
| [BASELINE.md](BASELINE.md) | Bun setup and the dead code in vanilla builds |
| [CLAUDE.md](CLAUDE.md) | Working notes: ground rules, Bun gotchas, pitfalls |
