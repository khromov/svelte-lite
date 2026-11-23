/**
 * scope.json lists the tests of the Svelte suite that svelte-lite does not aim to
 * pass, each with the feature it leaves out.
 *
 *   bun run scope                  how many tests each reason accounts for
 *   bun run scope record <reason> [text]
 *                                  put every test that fails in the last full run out of scope
 *                                  for <reason> (a key of `reasons` in scope.json). With [text],
 *                                  only the tests whose error contains it
 */
import { read_results } from '../harness/reporter.ts';
import { read_scope, split_key, unsupported_reason, without_variant, write_scope } from '../harness/scope.ts';

const [command, reason, matching] = process.argv.slice(2);
const scope = read_scope();
const baseline = read_results('upstream');

if (!baseline) throw new Error('No upstream baseline, run `bun run test:upstream` first');

if (command === 'record') {
	if (!scope.reasons[reason]) {
		throw new Error(`"${reason}" is not one of the reasons in scope.json: ${Object.keys(scope.reasons).join(', ')}`);
	}

	const errors = read_results('lite')?.failing ?? {};
	const failing = new Set(Object.keys(errors).filter((key) => !matching || errors[key].includes(matching)));

	// every variant of a sample that upstream runs, to tell whether all of them fail
	const variants = new Map<string, string[]>();

	for (const key of Object.keys(baseline.tests)) {
		const [suite, name] = split_key(key);
		const sample = `${suite} > ${without_variant(name)}`;
		variants.set(sample, [...(variants.get(sample) ?? []), key]);
	}

	let recorded = 0;

	for (const key of failing) {
		const [suite, name] = split_key(key);
		if (unsupported_reason(scope, suite, name)) continue;

		const all = variants.get(`${suite} > ${without_variant(name)}`) ?? [key];
		const whole_sample = all.every((other) => failing.has(other) || baseline.tests[other] !== 'passed');

		(scope.tests[suite] ??= {})[whole_sample ? without_variant(name) : name] = reason;
		recorded += 1;
	}

	write_scope(scope);
	console.log(`Put ${recorded} tests out of scope for "${reason}"`);
}

const counts = new Map<string, number>();
let in_scope = 0;

for (const [key, state] of Object.entries(baseline.tests)) {
	if (state !== 'passed') continue;

	const why = unsupported_reason(scope, ...split_key(key));
	if (why) counts.set(why, (counts.get(why) ?? 0) + 1);
	else in_scope += 1;
}

const total = in_scope + [...counts.values()].reduce((a, b) => a + b, 0);

console.log(`${in_scope.toLocaleString('en-US')} of the ${total.toLocaleString('en-US')} tests that pass upstream are in scope`);

for (const [why, count] of [...counts].sort((a, b) => b[1] - a[1])) {
	console.log(`${count.toLocaleString('en-US').padStart(7)}  ${scope.reasons[why] ?? why}`);
}
