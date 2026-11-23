# svelte-lite

A lean client runtime for Svelte 5 in TypeScript, measured against Svelte's own test suite.
README.md explains the harness, the three module states (own, borrowed, reused) and the commands.

## Ground rules

- Never edit anything under `vendor/`. It is a pinned checkout of Svelte, used as the test
  suite, as the compiler and server runtime, and as the reference to read.
- Never edit `scope.json` to make a failure go away. A test goes out of scope only when it
  fails because of a feature svelte-lite deliberately leaves out. Say which test and which
  feature, and let the person running the session decide.
- Only the client runtime is svelte-lite's own. Do not reimplement the compiler or anything
  under `internal/server`.
- The compiler is Svelte's, unmodified. Its output imports `svelte/internal/client`, so the
  names and signatures exported from `src/internal/client/index.ts` are fixed by it.

## Writing a module

- `src/` mirrors `vendor/svelte/packages/svelte/src`, file for file, with `.ts` in place of `.js`.
- A file that starts with `// @borrowed` re-exports Svelte's module. To make the module
  svelte-lite's own, replace the whole file with an implementation. It keeps the exports that
  other modules and compiled output use, and drops the ones that only serve a feature that is
  left out.
- A module of svelte-lite never imports from `vendor/`. It imports its siblings in `src/` by
  relative path with the `.ts` extension, whether they are borrowed or not.
- Svelte's module is the reference for behaviour. Port what is needed, and leave out the
  code paths for legacy mode, async and custom renderers instead of translating them.
- TypeScript is strict. Follow Svelte's naming (`snake_case` functions, short field names on
  signals and effects) so that the two stay easy to compare. Tabs for indentation.

## Keeping the bundle small

The point of this project is the size of the JavaScript that reaches the browser. What ships
is decided by what a bundler can prove unused, so:

- A feature's code must not sit in a path every app runs. If `mount()`, `set()`, `get()` or
  an effect's teardown references it, every app pays for it.
- Bundlers do not remove methods of a class that is used. Prefer functions to classes in
  anything every app loads.
- A feature that needs a hook in a hot path gets a module-level flag that only the feature's
  own entry point sets. With nothing importing that entry point, the bundler folds the flag
  to a constant and drops what it guards.
- Code behind `DEV` (from `esm-env`) is free in production builds.

## Testing

- `bun run test` has to stay green: every test that is in scope passes. Run a single suite
  or `FILTER=<sample>` while working, and the whole thing before calling something done.
- `bun run check` and `bun test` have to pass too.
- The suite writes compiled samples into `vendor/svelte/.../_output`. Those are ignored by
  git, and two runs at the same time in the same checkout overwrite each other's.
