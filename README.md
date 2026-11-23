# svelte-lite

A lean rewrite of Svelte 5 in TypeScript. The goal is parity with Svelte's own test suite, which
this repo runs unchanged from a pinned checkout of [sveltejs/svelte](https://github.com/sveltejs/svelte).

Right now `src/` is a stub: every entry point of the `svelte` package exists and exports nothing.

## Setup

Needs [Bun](https://bun.sh) and Node.js. Bun installs dependencies and runs the scripts. The
Svelte suite is written for vitest, which runs on Node as it does upstream.

```sh
git clone --recurse-submodules <url>
bun run setup
```

`bun run setup` initialises the submodule, installs dependencies and downloads headless Chromium
for the browser tests.

## Running the tests

| Command | What it does |
| --- | --- |
| `bun run test` | The Svelte suite against svelte-lite |
| `bun run test:upstream` | The same suite against Svelte itself, as a control |
| `bun run test:types` | Svelte's type tests against svelte-lite (`SVELTE_IMPL=upstream` for the control) |
| `bun test` | Unit tests of the harness |
| `bun run check` | Type-checks this repo's own code |

A run ends with a table of passed and failed tests per suite and the most common failure
messages, and records the outcome of every test in `.results/lite.json`. Once
`bun run test:upstream` has been run, the table also shows how many tests pass upstream, which
is the number to reach. That matters because a test file that fails to load registers no
tests at all, so its failures are not counted.

To work on something specific:

```sh
bun run test runtime-runes                           # one suite
FILTER=each-dynamic-html bun run test runtime-runes  # one sample, as in the Svelte repo
FILTER=/each/ bun run test                           # every sample matching a pattern
```

Setting `FILTER` also turns on vitest's default reporter, with the full error and stack trace
of every failure. An unfiltered run leaves those out, since they would number in the thousands.

## How it works

`vendor/svelte` is a git submodule pinned to a commit of Svelte's `main` branch. Nothing in it
is edited. `vitest.config.ts` mirrors Svelte's own vitest config and runs from inside the
submodule, so that the suite sees the directory layout it expects.

What differs from upstream is where imports lead, which `harness/` decides:

- `svelte` and `svelte/*` resolve through the `exports` of this repo's `package.json`. It has
  the same entry points as Svelte's.
- Some tests import Svelte's internals by path, such as `../../src/internal/client/proxy.js`.
  Those resolve to the file with the same path under `compat/`, which re-exports whatever
  svelte-lite has in its place. That way `src/` does not have to be laid out like Svelte's.
  See [compat/README.md](compat/README.md).
- Loading anything from the real Svelte sources while testing svelte-lite is an error, so
  a test cannot pass by accident. The same goes for the bundles that the browser tests build
  with esbuild, and for the type tests.

`bun run test:upstream` turns the redirects off and runs the suite against the Svelte sources in
the submodule. All 8,422 tests pass there, which is the evidence that a failure against
svelte-lite comes from svelte-lite and not from the harness.

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
`vitest.config.ts`.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | svelte-lite |
| `compat/` | Shims for the Svelte internals that tests import |
| `harness/` | Import resolution, the summary reporter and their tests |
| `scripts/` | Setup, type tests, and the tools for updating Svelte |
| `vendor/svelte/` | The pinned Svelte checkout (submodule) |
| `.results/` | Results of the last full run of each implementation (not committed) |
