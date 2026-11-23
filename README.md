# svelte-lite

A lean client runtime for Svelte 5, written in TypeScript. It runs the output of Svelte's own
compiler, leaves out the features that cost every app bytes whether it uses them or not, and is
measured against Svelte's own test suite, run unchanged from a pinned checkout of
[sveltejs/svelte](https://github.com/sveltejs/svelte).

Only the client runtime is svelte-lite's own. The compiler and the server runtime never reach
the browser, so they are Svelte's, reused as they are.

## Setup

Needs [Bun](https://bun.sh) and Node.js. Bun installs dependencies and runs the scripts. The
Svelte suite is written for vitest, which runs on Node as it does upstream.

```sh
git clone --recurse-submodules <url>
bun run setup
```

`bun run setup` initialises the submodule, installs dependencies and downloads headless Chromium
for the browser tests.

## Commands

| Command | What it does |
| --- | --- |
| `bun run test` | The Svelte suite against svelte-lite |
| `bun run test:upstream` | The same suite against Svelte itself, as a control and baseline |
| `bun run test:types` | Svelte's type tests against svelte-lite, minus the parts that cover custom renderers (`SVELTE_IMPL=upstream` for the control) |
| `bun test` | Unit tests of the harness |
| `bun run check` | Type-checks this repo's own code |
| `bun run size` | Bundle size of small apps, compared with Svelte (`SVELTE_IMPL=upstream` measures the reference) |
| `bun run borrowed` | Lists the client modules that are still Svelte's |
| `bun run scope` | Counts the tests that are out of scope, by the feature left out |

To work on something specific:

```sh
bun run test runtime-runes                           # one suite
FILTER=each-dynamic-html bun run test runtime-runes  # one sample, as in the Svelte repo
FILTER=/each/ bun run test                           # every sample matching a pattern
```

Setting `FILTER` also turns on vitest's default reporter, with the full error and stack trace
of every failure. A full run prints a table per suite, and lists the failing tests that are in
scope in `.results/lite-failing.txt`.

## Size

`bun run size` compiles a set of small apps, bundles each the way a production build would
(rollup with tree-shaking, `DEV` off, terser) and reports minified and gzipped bytes. Run it
with `SVELTE_IMPL=upstream` once to measure Svelte itself; after that, measuring svelte-lite
shows the difference per app. `--all` covers about 140 apps that each add one feature to a
counter, which shows what that feature costs when it is used.

## What is left out

`scope.json` names the features svelte-lite does not support and lists every test that fails
because of one of them. Those tests still run, and are reported as unsupported instead of
failed. Everything else that passes against Svelte has to pass against svelte-lite: a test
that upstream passes and that did not run counts as a failure too. `bun run scope` shows how
many tests each feature accounts for.

- **Legacy mode.** Every component is a runes component. The compiler entry point
  (`src/compiler/index.ts`) compiles in runes mode by default and rejects anything else.
- **`experimental.async` in the browser.** No `await` in components, no `fork()`, and a
  `pending` snippet is never shown. The suite runs with `SVELTE_NO_ASYNC=true` for both
  implementations. The scheduler is synchronous: there are no batches that hold their own
  view of the state.
- **Custom renderers.**

Using one of these fails with an error that says so, when compiling where that is possible.

### Behaviour that differs from Svelte

The synchronous scheduler gives up some edge cases of Svelte's. The first three have tests
in the suite, which are out of scope for that reason:

- **Teardowns read current values.** An effect's cleanup, `onDestroy` and the cleanup of an
  action or attachment see state as it is now, not as it was before the change that caused
  the teardown. A cleanup that dereferences state which has just become `null` throws.
- **Blocks update when they re-run.** When an `$effect` writes to state that an `{#if}`,
  `{#each}` or similar depends on, the DOM changes right away. In Svelte it changes at the end
  of the flush, so effects later in the same flush still see the old DOM.
- **An effect does not re-run because of its own write** to state that it only starts to
  depend on during that same run.
- `$state.eager(x)` is `x`, `$effect.pending()` is always `0`, and `settled()` is `tick()`.
- In production builds, misuse (`state_unsafe_mutation`, `effect_orphan` and the like) is not
  reported. It still is in dev.
- If the expression of a `bind:this` throws while the binding is reset during teardown, the
  error is swallowed.
- When a `bind:value` setter changes what was typed (`(v) => (text = v.toUpperCase())`), the
  value is right but the caret moves to the end of the input. Svelte keeps it in place.
- `hydratable()` and `fork()` fail with svelte-lite's own error instead of Svelte's. Both need
  `experimental.async` there too.

## How it works

`vendor/svelte` is a git submodule pinned to a commit of Svelte's `main` branch. Nothing in it
is edited. `vitest.config.ts` mirrors Svelte's own vitest config and runs from inside the
submodule, so that the suite sees the directory layout it expects.

`src/` mirrors the layout of Svelte's `src/`, one file per module. A module is in one of three
states:

- **svelte-lite's own**: a TypeScript implementation.
- **Borrowed**: a file that starts with `// @borrowed` and re-exports Svelte's module. This is
  how the suite stayed green while the runtime was replaced one module at a time. Nothing is
  borrowed at present. `bun run borrowed` lists what is, and which of Svelte's modules have no
  counterpart because svelte-lite does not support what they are for.
- **Reused**: the compiler and the server runtime, for good.

What differs from upstream is where imports lead, which `harness/` decides:

- `svelte` and `svelte/*` resolve through the `exports` of this repo's `package.json`. It has
  the same entry points as Svelte's.
- A module of Svelte that is still in use (borrowed, or part of the server runtime) gets
  svelte-lite's version of whatever it imports, so there is only ever one instance of a module.
- Some tests import Svelte's internals by path, such as `../../src/internal/client/proxy.js`.
  Those resolve to the file with the same path under `compat/`.
  See [compat/README.md](compat/README.md).
- Loading a module of the real Svelte that is neither reused nor still borrowed is an error,
  so a test cannot pass against the wrong implementation by accident. The same goes for the
  bundles that the browser tests build with esbuild. The type tests only accept types of
  Svelte's that belong to the compiler or the server runtime.

`bun run test:upstream` turns all of this off and runs the suite against the Svelte sources in
the submodule, where every test passes. That is the evidence that a failure against svelte-lite
comes from svelte-lite and not from the harness, and its results are the baseline.

Dependencies are pinned to the versions in Svelte's lockfile, including transitive ones through
`overrides` in `package.json`. Expected output in the samples depends on them: newer releases
of jsdom's dependencies were enough to fail a dozen tests.

## Updating Svelte

```sh
bun run upstream:update
```

This moves the submodule to the tip of Svelte's `main`, then:

1. pins dependencies to the new lockfile (`bun run upstream:sync-deps`)
2. creates `compat/` shims for internals that tests newly import (`bun run compat:audit --scaffold`)
3. checks that `package.json` still has every entry point upstream has (`bun test`)
4. runs the suite against the new Svelte to get a new baseline (`bun run test:upstream`)

If `vitest.config.js` changed upstream, a warning says so until the change is carried over to
`vitest.config.ts`. New modules upstream show up in `bun run borrowed`.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | svelte-lite, in the layout of Svelte's `src/` |
| `compat/` | Shims for the Svelte internals that tests import |
| `scope.json` | The features left out, and the tests that fail because of them |
| `harness/` | Import resolution, the scoreboard and their tests |
| `scripts/` | Setup, test runner, type tests, and the tools for updating Svelte |
| `vendor/svelte/` | The pinned Svelte checkout (submodule) |
| `.results/` | Results of the last full run of each implementation (not committed) |
