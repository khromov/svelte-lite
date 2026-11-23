# compat

Some of Svelte's tests import its internals by path rather than through the package:

```js
import { proxy } from '../../src/internal/client/proxy';
import { ELEMENT_NODE } from '#client/constants';
```

When the suite runs against svelte-lite, an import of `src/<path>` in the Svelte repo resolves to
`compat/<path>.ts` here. Each file re-exports the names the tests use from wherever svelte-lite
implements them:

```ts
// compat/internal/client/proxy.ts
export { proxy } from '../../../src/reactivity/proxy.ts';
```

The unit tests that live in Svelte's `src/` (`src/**/*.test.ts`) import their neighbours the
same way, and are redirected the same way.

`bun run compat:audit` lists every shim the tests need and the names each one is still missing.
A missing name only fails the tests that use it. A missing file stops every test that imports
it from loading, so the audit exits with an error for those, and
`bun run compat:audit --scaffold` creates them.

`internal/client/constants.ts` is the one shim with content from the start: the suite's own
helpers use the DOM node types in it to normalise HTML before comparing.
