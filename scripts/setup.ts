/**
 * Gets a fresh clone ready to run the suite. Uses nothing that has to be installed first.
 *
 *   bun run setup
 */
import path from 'node:path';
import { $ } from 'bun';

const root = path.resolve(import.meta.dir, '..');

$.cwd(root);

// the Svelte checkout whose tests are run, at the commit this repo pins
await $`git submodule update --init --depth 1`;

await $`bun install --frozen-lockfile`;

// the runtime-browser suite runs in headless Chromium
await $`bunx playwright install chromium --only-shell`;
