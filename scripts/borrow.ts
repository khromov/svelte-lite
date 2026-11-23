/**
 * `src/` mirrors the layout of Svelte's `src/`. A module that svelte-lite has not
 * written yet is a one-line stub that re-exports Svelte's, marked `// @borrowed`.
 * Replacing the stub with real code is how a module becomes svelte-lite's own.
 *
 *   bun run borrowed            list what is still borrowed
 *   bun run borrowed --create   create stubs for upstream modules that have no file in src/
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, UPSTREAM_SRC } from '../harness/paths.ts';
import { is_borrowed, is_reused, to_own } from '../harness/resolve.ts';

const relative = (file: string) => path.relative(ROOT, file);
const lines = (file: string) => fs.readFileSync(file, 'utf8').split('\n').length;

/** Every upstream module that could ship to a browser, plus the type declarations next to them */
const upstream = [...new Bun.Glob('**/*.{js,d.ts}').scanSync({ cwd: UPSTREAM_SRC, absolute: true })]
	.filter((file) => !is_reused(file) && !file.endsWith('ambient.d.ts'))
	.sort();

if (process.argv.includes('--create')) {
	let created = 0;

	for (const file of upstream) {
		const own = to_own(file);
		if (fs.existsSync(own)) continue;

		const from = path.relative(path.dirname(own), file);
		const statement = file.endsWith('.d.ts') ? 'export type *' : 'export *';

		fs.mkdirSync(path.dirname(own), { recursive: true });
		fs.writeFileSync(
			own,
			`// @borrowed from Svelte until svelte-lite has its own version of this module\n` +
				`${statement} from '${from}';\n`
		);
		created += 1;
	}

	console.log(`Created ${created} stubs`);
}

const borrowed = upstream.filter((file) => !file.endsWith('.d.ts') && is_borrowed(to_own(file)));
const own = upstream.filter((file) => !file.endsWith('.d.ts') && !borrowed.includes(file));
const missing = own.filter((file) => !fs.existsSync(to_own(file)));

for (const file of borrowed) {
	console.log(`${String(lines(file)).padStart(5)}  ${relative(to_own(file))}`);
}

const total = borrowed.reduce((sum, file) => sum + lines(file), 0);

console.log();
console.log(
	`${borrowed.length} modules borrowed from Svelte (${total.toLocaleString('en-US')} lines there), ` +
		`${own.length - missing.length} are svelte-lite's own`
);

if (missing.length > 0) {
	console.log(`${missing.length} upstream modules have no counterpart, which means they are not supported:`);
	for (const file of missing) console.log(`       ${path.relative(UPSTREAM_SRC, file)}`);
}
