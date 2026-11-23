/**
 * Runs the Svelte suite through vitest. Arguments are passed on.
 *
 * vitest fails when any test fails. Against svelte-lite, tests that scope.json puts
 * out of scope are expected to, so this goes by what the reporter counted instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS, ROOT, get_impl } from '../harness/paths.ts';

const last_run = path.join(RESULTS, 'last-run.json');
fs.rmSync(last_run, { force: true });

const { exitCode } = Bun.spawnSync(
	[path.join(ROOT, 'node_modules/.bin/vitest'), 'run', ...process.argv.slice(2)],
	{ cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'] }
);

if (exitCode !== 0 && get_impl() === 'lite' && fs.existsSync(last_run)) {
	const { failing, unhandled } = JSON.parse(fs.readFileSync(last_run, 'utf8'));
	process.exit(failing > 0 || unhandled > 0 ? 1 : 0);
}

process.exit(exitCode);
