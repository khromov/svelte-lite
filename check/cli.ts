#!/usr/bin/env bun
/**
 * Checks components for syntax that svelte-lite does not support, before a build that does
 * not compile through svelte-lite's own compiler entry point (SvelteKit's, for one).
 *
 *   bun check/cli.ts src                     every .svelte file under src/, skipping node_modules
 *   bun check/cli.ts src/App.svelte          the files named
 *   bun check/cli.ts --custom-element src    as if compiled with `customElement: true`
 *
 * Prints one line per finding and exits with 1 if there is any, 0 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';
import { check } from './index.ts';

const args = process.argv.slice(2);
const custom_element = args.includes('--custom-element');
const targets = args.filter((arg) => !arg.startsWith('--'));

if (targets.length === 0) {
	console.error('Usage: svelte-lite-check [--custom-element] <file or directory>...');
	process.exit(2);
}

/** The .svelte files of a directory, outside of node_modules and hidden directories */
function* svelte_files(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const file = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
			yield* svelte_files(file);
		} else if (entry.name.endsWith('.svelte')) {
			yield file;
		}
	}
}

let files = 0;
let findings = 0;

for (const target of targets) {
	const stat = fs.statSync(target, { throwIfNoEntry: false });

	if (!stat) {
		console.error(`${target}: no such file or directory`);
		process.exit(2);
	}

	for (const file of stat.isDirectory() ? svelte_files(target) : [target]) {
		files += 1;

		for (const finding of check(fs.readFileSync(file, 'utf8'), { filename: file, customElement: custom_element })) {
			findings += 1;
			console.log(`${file}:${finding.line}:${finding.column + 1}  ${finding.found}: ${finding.instead}`);
		}
	}
}

const s = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
console.error(
	findings === 0
		? `${s(files, 'file')} checked: nothing that svelte-lite does not support`
		: `${s(findings, 'finding')} in ${s(files, 'file')} checked`
);

process.exit(findings > 0 ? 1 : 0);
