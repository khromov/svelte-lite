# What dropping async saved

Svelte's scheduler is built around `experimental.async`. State changes are grouped into
batches that each hold their own view of the state, so that several can be pending at once,
be rebased on each other, or be thrown away. Every app ships that machinery, whether or not
it uses async. svelte-lite does not support async in the browser, so its scheduler is
synchronous, and the machinery is gone.

Compared here: Svelte 5.59.1 at [`90ad4e8`][svelte] and svelte-lite at [`70bb7c0`][lite].

## In the bundle

Gzipped bytes of a production build, measured by rebuilding the app after each removal.

| What went | Static page | Counter | TodoMVC-style app |
| --- | ---: | ---: | ---: |
| Batches with their own view of the state, forks, pending tracking | 5,153 | 3,760 | 3,718 |
| Blocks holding their DOM changes until the end of a flush | 909 | 965 | 1,564 |
| The boundary that `mount()` wrapped every app in | 687 | 672 | 670 |
| The `Batch` class and a version per dependency | 603 | 443 | 469 |
| `await` in templates and deriveds | 0 | 629 | 600 |
| **Total** | **7,352** | **6,469** | **7,021** |
| Share of the app's size with Svelte | 61% | 50% | 39% |

The second row is an estimate: that code went in the same step as something else. The rest
is measured.

## In the source

Lines of code, with types and comments stripped from both sides.

| File | Svelte | svelte-lite |
| --- | ---: | ---: |
| [reactivity/batch][s-batch] → [ours][l-batch] | 1,104 | 206 |
| [runtime][s-runtime] → [ours][l-runtime] | 887 | 421 |
| [reactivity/async][s-async] → [ours][l-async] | 326 | 4 |
| [reactivity/deriveds][s-deriveds] → [ours][l-deriveds] | 339 | 154 |
| [dom/blocks/boundary][s-boundary] → [ours][l-boundary] | 426 | 204 |
| [dom/blocks/each][s-each] → [ours][l-each] | 554 | 375 |
| [dom/blocks/await][s-await] → [ours][l-await] | 158 | 107 |
| [dom/blocks/branches][s-branches] → [ours][l-branches] | 145 | 42 |
| [dom/blocks/async][s-blocks-async] → removed | 46 | 0 |
| [hydratable][s-hydratable] → [ours][l-hydratable] | 22 | 4 |
| **Total** | **4,007** | **1,517** |

Not every line that went from these files was async. Custom renderer and legacy code left
them too, and `each` got a simpler way of reordering. About 2,100 of the 2,490 lines were
for async.

## What it costs

- No `await` in components, no `fork()`, no `pending` snippet, no `$effect.pending()`.
- A block that re-runs because an effect wrote to state changes the DOM right away. In Svelte
  it waits for the end of the flush.
- About 1,240 of Svelte's tests only exist with async on. They are not run, and 11 more are
  out of scope.

[svelte]: https://github.com/sveltejs/svelte/tree/90ad4e870c72aa76db35ecc7e46f0b027ffe175a/packages/svelte/src/internal/client
[lite]: https://github.com/khromov/svelte-lite/tree/70bb7c032d2c2388a40f902f7d6f65e792695161/src/internal/client

[s-batch]: https://github.com/sveltejs/svelte/blob/90ad4e870c72aa76db35ecc7e46f0b027ffe175a/packages/svelte/src/internal/client/reactivity/batch.js
[l-batch]: https://github.com/khromov/svelte-lite/blob/70bb7c032d2c2388a40f902f7d6f65e792695161/src/internal/client/reactivity/batch.ts
[s-runtime]: https://github.com/sveltejs/svelte/blob/90ad4e870c72aa76db35ecc7e46f0b027ffe175a/packages/svelte/src/internal/client/runtime.js
[l-runtime]: https://github.com/khromov/svelte-lite/blob/70bb7c032d2c2388a40f902f7d6f65e792695161/src/internal/client/runtime.ts
[s-async]: https://github.com/sveltejs/svelte/blob/90ad4e870c72aa76db35ecc7e46f0b027ffe175a/packages/svelte/src/internal/client/reactivity/async.js
[l-async]: https://github.com/khromov/svelte-lite/blob/70bb7c032d2c2388a40f902f7d6f65e792695161/src/internal/client/reactivity/async.ts
[s-deriveds]: https://github.com/sveltejs/svelte/blob/90ad4e870c72aa76db35ecc7e46f0b027ffe175a/packages/svelte/src/internal/client/reactivity/deriveds.js
[l-deriveds]: https://github.com/khromov/svelte-lite/blob/70bb7c032d2c2388a40f902f7d6f65e792695161/src/internal/client/reactivity/deriveds.ts
[s-boundary]: https://github.com/sveltejs/svelte/blob/90ad4e870c72aa76db35ecc7e46f0b027ffe175a/packages/svelte/src/internal/client/dom/blocks/boundary.js
[l-boundary]: https://github.com/khromov/svelte-lite/blob/70bb7c032d2c2388a40f902f7d6f65e792695161/src/internal/client/dom/blocks/boundary.ts
[s-each]: https://github.com/sveltejs/svelte/blob/90ad4e870c72aa76db35ecc7e46f0b027ffe175a/packages/svelte/src/internal/client/dom/blocks/each.js
[l-each]: https://github.com/khromov/svelte-lite/blob/70bb7c032d2c2388a40f902f7d6f65e792695161/src/internal/client/dom/blocks/each.ts
[s-await]: https://github.com/sveltejs/svelte/blob/90ad4e870c72aa76db35ecc7e46f0b027ffe175a/packages/svelte/src/internal/client/dom/blocks/await.js
[l-await]: https://github.com/khromov/svelte-lite/blob/70bb7c032d2c2388a40f902f7d6f65e792695161/src/internal/client/dom/blocks/await.ts
[s-branches]: https://github.com/sveltejs/svelte/blob/90ad4e870c72aa76db35ecc7e46f0b027ffe175a/packages/svelte/src/internal/client/dom/blocks/branches.js
[l-branches]: https://github.com/khromov/svelte-lite/blob/70bb7c032d2c2388a40f902f7d6f65e792695161/src/internal/client/dom/blocks/branches.ts
[s-blocks-async]: https://github.com/sveltejs/svelte/blob/90ad4e870c72aa76db35ecc7e46f0b027ffe175a/packages/svelte/src/internal/client/dom/blocks/async.js
[s-hydratable]: https://github.com/sveltejs/svelte/blob/90ad4e870c72aa76db35ecc7e46f0b027ffe175a/packages/svelte/src/internal/client/hydratable.js
[l-hydratable]: https://github.com/khromov/svelte-lite/blob/70bb7c032d2c2388a40f902f7d6f65e792695161/src/internal/client/hydratable.ts
