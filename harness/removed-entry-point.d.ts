// What the type tests resolve an entry point to that svelte-lite removed (see
// scripts/test-types.ts): a module that exports nothing, so that importing anything from it
// is an error, instead of TypeScript finding Svelte's own entry point.
export {};
