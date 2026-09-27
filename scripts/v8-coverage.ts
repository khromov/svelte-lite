/**
 * Node child of scripts/byte-coverage.ts: runs one bundle through the behavioural harness
 * (harness.ts: SSR HTML -> hydrate() -> the app's interaction test, in happy-dom) with V8
 * precise *block* coverage on, and prints the bundle's V8 coverage functions as JSON.
 *
 *   node scripts/v8-coverage.ts <variant> <app> <absolute bundle path>
 *
 * Requires Node >= 26 (runs .ts natively; V8 is what gives block coverage, Bun's
 * JavaScriptCore has no equivalent).
 */
import { Session } from 'node:inspector/promises';
import { pathToFileURL } from 'node:url';
import { harness } from '../harness.ts';

const major = Number(process.versions.node.split('.')[0]);
if (!(major >= 26)) throw new Error(`scripts/v8-coverage.ts needs Node >= 26 (got ${process.version})`);

const [variant, app, bundle] = process.argv.slice(2);
if (!bundle) throw new Error('usage: node scripts/v8-coverage.ts <variant> <app> <bundle>');

const session = new Session();
session.connect();
await session.post('Profiler.enable');
// callCount + detailed = block coverage: every function *and* every block inside it gets a count
await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });

const res = await harness(variant, app, bundle);
const { result } = await session.post('Profiler.takePreciseCoverage');
await session.post('Profiler.stopPreciseCoverage');
session.disconnect();

if (!res.ok) {
	console.error(`bundle failed its behavioural test under Node: ${JSON.stringify(res)}`);
	process.exit(1);
}
const script = result.find((s) => s.url === pathToFileURL(bundle).href);
if (!script) {
	console.error(`no coverage recorded for ${bundle}`);
	process.exit(1);
}
process.stdout.write(JSON.stringify(script.functions));
process.exit(0);
