// Stands in for upstream src/internal/client/error-handling.js
import { set_has_boundaries } from '../../../src/internal/client/error-handling.ts';

export * from '../../../src/internal/client/error-handling.ts';

// svelte-lite only looks for a boundary when an error is thrown once the app has created one
// (`boundary` says so), so that an app without `<svelte:boundary>` does not ship the search.
// Svelte's unit test of `invoke_error_boundary` hands it boundary effects that it made up
// itself, so it gets what `boundary` would have done for them.
set_has_boundaries();
