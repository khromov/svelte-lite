# svelte-lite

A lean client runtime for Svelte 5, written in TypeScript. It runs the output of Svelte's own
compiler, leaves out the features that cost every app bytes whether it uses them or not and the
API and syntax that Svelte deprecates, and is measured against Svelte's own test suite, run
unchanged from a pinned checkout of
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
| `bun run test:prod` | Runs the samples of the main runtime suite as production bundles (`--minify` adds terser) |
| `bun run test:types` | Svelte's type tests against svelte-lite, minus the parts that cover custom renderers and the removed API (`SVELTE_IMPL=upstream` for the control) |
| `bun test` | Unit tests of the harness and of the syntax check |
| `bun run check` | Type-checks this repo's own code |
| `bun run check:syntax <paths>` | Finds the syntax svelte-lite does not support in `.svelte` files, see [The syntax check](#the-syntax-check) |
| `bun check/cross-check.ts` | Compares the syntax check with Svelte's compiler over the components of the suite (`--files` lists them) |
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

Gzipped, against Svelte 5.59.1:

| App | svelte-lite | Svelte | |
| --- | ---: | ---: | ---: |
| A static page | 1,896 B | 12,037 B | −84% |
| A counter | 3,004 B | 12,931 B | −77% |
| The same, hydrated | 3,487 B | 13,653 B | −74% |
| A keyed list | 5,469 B | 14,754 B | −63% |
| An element with spread attributes | 6,045 B | 16,547 B | −63% |
| A TodoMVC-style app, three components | 8,237 B | 18,196 B | −55% |
| The same with a transition and an animation | 10,571 B | 20,050 B | −47% |

Transitions and animations are the clearest case of paying only for what is used: their
plumbing in effects and `{#each}` is behind two flags that only `transition()` and
`animation()` set, so an app without either carries none of it.

The savings rely on the bundler dropping what an app does not use, which the test suite never
exercises: it loads the modules one by one, with `DEV` on. `bun run test:prod` closes that gap.
It builds each sample of the runtime-runes suite that can run that way as a production bundle
and runs it in jsdom. `scripts/prod/skip.json` lists the samples that cannot, with the reason.

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
- **The API that Svelte deprecates.** These are gone from the runtime, the entry points and
  the types:

  | Removed | Use instead |
  | --- | --- |
  | `createEventDispatcher` | Callback props (`let { onselect } = $props()`); in a custom element, `$host().dispatchEvent(...)` |
  | `beforeUpdate`, `afterUpdate` | `$effect.pre`, `$effect` |
  | The `events` option of `mount` and `hydrate` | Callback props |
  | `svelte/legacy`: `createClassComponent`, `asClassComponent` | `mount`, `hydrate`, `unmount` |
  | `svelte/legacy`: `run` | `$effect.pre` |
  | `svelte/legacy`: `handlers`, `createBubbler`, and `once`, `preventDefault`, `self`, `stopPropagation`, `stopImmediatePropagation`, `trusted`, `passive`, `nonpassive` | A function that calls the handlers, a callback prop, the same lines in the handler, `on()` of `svelte/events` with its options |
  | `spring` and `tweened` of `svelte/motion` | The `Spring` and `Tween` classes |
  | The compiler option `compatibility.componentApi: 4` | `mount` |

  An import of one of these fails when bundling. The `events` option is the exception: a
  bundler does not look into options, and passing it does nothing.
- **Syntax that svelte-lite does not support.** The deprecated syntax, also where Svelte's
  compiler turns it into something svelte-lite could run, besides what needs legacy mode,
  `experimental.async` or a custom renderer:

  | Rejected | Write instead |
  | --- | --- |
  | `on:click={handler}`, also on `<svelte:window>`, `<svelte:document>`, `<svelte:body>` | `onclick={handler}` |
  | Its modifiers: `\|preventDefault`, `\|stopPropagation`, `\|stopImmediatePropagation`, `\|self`, `\|trusted` | The same in the handler: `event.preventDefault()`, `if (event.target === event.currentTarget)`, `if (event.isTrusted)` |
  | `\|capture`, `\|once`, `\|passive`, `\|nonpassive` | `onclickcapture`; `on(element, type, handler, options)` of `svelte/events` |
  | `on:click` without a handler (forwarding) | A callback prop, passed on: `<button {onclick}>` |
  | `on:done={handler}` on a component | A callback prop: `ondone={handler}` |
  | `<slot>`, `<slot name="x">`, outside a custom element | `{@render children?.()}`, `{@render x?.()}` |
  | `slot="x"`, `<svelte:fragment slot="x">` | `{#snippet x()}...{/snippet}` |
  | `let:item` | `{#snippet children(item)}...{/snippet}` |
  | `<svelte:component this={C}>` | `<C />` |
  | `<svelte:self>` | The component importing itself |
  | `<script context="module">` | `<script module>` |
  | `accessors` and `immutable` in `<svelte:options>` | Nothing: they have no effect in runes mode |
  | `export let`, `$:`, `$$props`, `$$restProps`, `runes={false}`, `attr={a, b}` (legacy mode) | `$props()`, `$derived` or `$effect`, `$props()`, a rest element in `$props()`, nothing, `attr={(a, b)}` |
  | `await` in markup or at the top level of a component (`experimental.async`) | `{#await}`, or an `$effect` |
  | `customRenderer` in `<svelte:options>` | Nothing: svelte-lite renders to the DOM |

  `<slot>` and `$$slots` stay in a custom element, which renders its light DOM children
  through them.

Using one of these fails with an error that says so: when compiling through svelte-lite's
compiler entry point, and otherwise when bundling or with [the syntax check](#the-syntax-check).

### The syntax check

`src/compiler/index.ts` rejects the syntax above in every component it compiles, with where it
is and what to write instead:

```
svelte-lite does not support `on:click`, an `on:` directive (src/App.svelte:3:9): use the `onclick` attribute
```

A build that calls Svelte's compiler directly, as SvelteKit does through vite-plugin-svelte,
does not go through it. The same check runs on its own before such a build, and exits with 1
if it finds anything:

```sh
bun run check:syntax src                 # in this repo, or
bun <svelte-lite>/check/cli.ts src       # from a SvelteKit app, on its own components
```

It takes files and directories (searched for `.svelte` files, skipping `node_modules`), and
`--custom-element` for components compiled with `customElement: true`. It works from the AST
of Svelte's own parser, and is a function too (`check(source, options)` of `check/index.ts`),
for a build plugin to call. Its rules are one table, `RULES` in `check/index.ts`.

`bun check/cross-check.ts` holds it against Svelte's compiler over the 5,189 components in the
suite's samples: the check finds something exactly where the compiler, in runes mode without
`experimental.async`, warns about deprecated syntax or fails on legacy or `await` syntax, at the
same position. Besides that it finds the deprecated syntax that the compiler does not warn
about: `on:` on a component, forwarding from one, `let:`, `slot="x"`, `<svelte:fragment>` and
`on:` on `<svelte:window>`. It takes about 0.1 ms per component.

### Behaviour that differs from Svelte

Besides leaving features out, svelte-lite gives up a number of niceties for size. Where the
suite has a test for one, that test is out of scope under the reason given in `scope.json`.
Each of these was made as a commit of its own, with the bytes it saved in the message, so
that any one of them can be reverted.

**Reactivity**

- **Teardowns read older values only up to the end of a flush.** An effect's cleanup,
  `onDestroy` and the cleanup of an action or attachment see state as it was before the
  change that caused the teardown, as in Svelte, while the flush that the change set off is
  running. A teardown that runs later, after an outro transition, sees state as it is then.
  A derived that a teardown assigns to, or reads after assigning to what it depends on, can
  give a value that Svelte would not.
- **Blocks update when they re-run.** When an `$effect` writes to state that an `{#if}`,
  `{#each}` or similar depends on, the DOM changes right away. In Svelte it changes at the end
  of the flush, so effects later in the same flush still see the old DOM.
- An effect that writes to state and only afterwards reads it for the first time does not run
  again because of that write. Reading and then writing re-runs it, as in Svelte.
- `$state.eager(x)` is `x`, `$effect.pending()` is always `0`, and `settled()` is `tick()`.
- If the expression of a `bind:this` throws while the binding is reset during teardown, the
  error is swallowed.

**Events**

- **Events are not delegated.** `onclick={...}` is a listener on its own element. Handlers
  run in the browser's order, and there is one listener per element instead of one per root,
  which matters in very long lists.
- A handler written as an attribute runs before the listener of a `bind:` on the same element.
  `<input bind:checked={on} onchange={() => use(on)}>` sees `on` as it was before the change.
  Read `event.currentTarget.checked` instead.

**Spread attributes**

On an element with a spread (`{...attrs}`, `...rest` props), and on a `<svelte:element>` with
dynamic attributes, `class`, `style`, attachments, the values of `<select>` and `<option>` and
the names of attributes are handled as in Svelte. Inputs, `autofocus` and custom elements get
no special treatment there. Elements without a spread are not affected by any of this.

- `autofocus` does not focus the element.
- On an `<input>`, `type` is not set before `value`: the order of the keys decides. A `value`
  or `checked` that becomes `undefined` does not reset the input: pass `''` or `false`.
  When hydrating, the `value` and `checked` attributes the server rendered stay, so a form
  reset goes back to them.
- A custom element is treated like any other element: a string is set as an attribute, also
  when the element has a property of that name.

**Bindings and actions**

- A `bind:value` setter that refuses or changes what was typed is not written back to the
  input right away. A setter that produces a new value (`(v) => (text = v.toUpperCase())`)
  shows it, with the caret at the end of the input.
- `use:action={param}` calls the action's `update` when the expression gives a different
  value, not when the parameter is mutated in place.

**Lists**

- Reordering a keyed `{#each}` moves more elements than Svelte does. The resulting order is
  the same. Moving the first of n items to the end moves the other n−1, where Svelte moves one.

**Production builds**

- Errors are thrown as `https://svelte.dev/e/<number>`. The table at the top of
  `src/internal/client/errors.ts` gives the name for each number. Dev builds have the full
  messages.
- Misuse (`state_unsafe_mutation`, `effect_orphan` and the like) is only reported in dev.
- There is no Trusted Types policy. A page whose CSP has `require-trusted-types-for 'script'`
  needs a `default` policy of its own.
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
- Three drivers of the suite mount the component of each sample with `createClassComponent`
  of `svelte/legacy`, which svelte-lite removed. Those files, and only those, get a stand-in
  built on `mount` and `hydrate` (`harness/support/legacy.ts`, listed in `harness/removed.ts`).
  It is test support: nothing in `package.json` leads to it. Anything else that imports
  `svelte/legacy` fails.
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
3. checks that `package.json` still has every entry point upstream has, minus those that
   `harness/removed.ts` lists (`bun test`)
4. runs the suite against the new Svelte to get a new baseline (`bun run test:upstream`)

If `vitest.config.js` changed upstream, a warning says so until the change is carried over to
`vitest.config.ts`. New modules upstream show up in `bun run borrowed`.

## Layout

| Path | Contents |
| --- | --- |
| `src/` | svelte-lite, in the layout of Svelte's `src/` |
| `check/` | The syntax check, its command line, its tests and its comparison with the compiler |
| `compat/` | Shims for the Svelte internals that tests import |
| `scope.json` | The features left out, and the tests that fail because of them |
| `harness/` | Import resolution, the scoreboard, the list of removed API with the stand-ins the suite's drivers get for it, and their tests |
| `scripts/` | Setup, test runner, type tests, and the tools for updating Svelte |
| `vendor/svelte/` | The pinned Svelte checkout (submodule) |
| `.results/` | Results of the last full run of each implementation (not committed) |
