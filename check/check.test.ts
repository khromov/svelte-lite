import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/compiler/index.ts';
import { RULES, check } from './index.ts';

/** The rules that find something in `source` */
const rules = (source: string, options = {}) => check(source, options).map((finding) => finding.rule);

/**
 * Every rule has cases where it finds something and cases where it does not. `found` are
 * components in which the rule finds something exactly once, `fine` are components in which
 * nothing at all is found.
 */
const cases: Record<string, { found: string[]; fine: string[] }> = {
	event_directive: {
		found: [
			`<button on:click={() => {}}>x</button>`,
			`<form on:submit|preventDefault|once={() => {}}></form>`,
			`<svelte:element this="div" on:click={() => {}} />`
		],
		fine: [`<button onclick={() => {}}>x</button>`, `<div onclickcapture={() => {}}></div>`]
	},
	event_forwarding: {
		found: [
			`<button on:click>x</button>`,
			`<script>import Child from './Child.svelte';</script><Child on:done />`,
			`<svelte:window on:resize />`
		],
		fine: [
			`<script>let { onclick } = $props();</script><button {onclick}>x</button>`,
			`<script>import Child from './Child.svelte'; let { ondone } = $props();</script><Child {ondone} />`
		]
	},
	component_event: {
		found: [
			`<script>import Child from './Child.svelte';</script><Child on:done={() => {}} />`,
			`<script>import Child from './Child.svelte';</script><Child on:done|once={() => {}} />`,
			`<script>let { Child } = $props();</script><Child on:done={() => {}} />`
		],
		fine: [
			`<script>import Child from './Child.svelte';</script><Child ondone={() => {}} />`,
			`<script>import Child from './Child.svelte';</script><Child {...{ ondone() {} }} />`
		]
	},
	slot_element: {
		found: [`<div><slot /></div>`, `<slot name="header">fallback</slot>`, `<slot item={1} />`],
		fine: [
			`<script>let { children } = $props();</script>{@render children?.()}`,
			`<svelte:options customElement="my-element" /><slot />`,
			`<div slot="x"></div>`
		]
	},
	slot_attribute: {
		found: [
			`<script>import Child from './Child.svelte';</script><Child><p slot="header">x</p></Child>`,
			`<script>import Child from './Child.svelte';</script><Child><Child slot="body" /></Child>`
		],
		fine: [
			`<script>import Child from './Child.svelte';</script><Child>{#snippet header()}<p>x</p>{/snippet}</Child>`,
			`<my-element><p slot="header">x</p></my-element>`,
			`<div><span slot="a">x</span></div>`
		]
	},
	svelte_fragment: {
		found: [
			`<script>import Child from './Child.svelte';</script><Child><svelte:fragment slot="header">x</svelte:fragment></Child>`,
			`<script>import Child from './Child.svelte';</script><Child><svelte:fragment>x</svelte:fragment></Child>`
		],
		fine: [`<script>import Child from './Child.svelte';</script><Child>{#snippet header()}x{/snippet}</Child>`]
	},
	window_event_directive: {
		found: [
			`<svelte:window on:keydown={() => {}} />`,
			`<svelte:document on:visibilitychange={() => {}} />`,
			`<svelte:body on:mouseenter|once={() => {}} />`
		],
		fine: [`<svelte:window onkeydown={() => {}} />`, `<svelte:body onmouseenter={() => {}} />`]
	},
	export_let: {
		found: [`<script>export let x;</script>`, `<script>export let x = 1, y;</script>`],
		fine: [
			`<script>let { x } = $props();</script>`,
			`<script>export const x = 1; export function f() {}</script>`,
			`<script module>export let x = 1;</script>`
		]
	},
	reactive_statement: {
		found: [`<script>let a = $state(1); $: b = a * 2;</script>`, `<script>$: { console.log(1) }</script>`],
		fine: [
			`<script>let a = $state(1); let b = $derived(a * 2);</script>`,
			`<script module>$: x = 1;</script>`,
			`<script>function f() { $: for (;;) break $; }</script>`
		]
	},
	dollar_props: {
		found: [`<script>console.log($$props);</script>`, `<p>{$$props.a}</p>`],
		fine: [`<script>let props = $props(); console.log(props.$$props, { $$props: 1 });</script>`]
	},
	dollar_rest_props: {
		found: [`<p {...$$restProps}></p>`],
		fine: [`<script>let { a, ...rest } = $props();</script><p {...rest}></p>`]
	},
	options_runes_false: {
		found: [`<svelte:options runes={false} /><p>x</p>`],
		fine: [`<svelte:options runes /><p>x</p>`, `<svelte:options runes={true} /><p>x</p>`]
	},
	attribute_sequence: {
		found: [`<script>let a = 1, b = 2;</script><div title={a, b}></div>`],
		fine: [
			`<script>let a = 1, b = 2;</script><div title={(a, b)}></div>`,
			`<script>let a = 1;</script><div title={a}>{a, a}</div>`
		]
	},
	await_expression: {
		found: [
			`<script>let x = await fetch('a');</script>`,
			`<script>let p = Promise.resolve(1);</script>{await p}`,
			`<script>let p = Promise.resolve(1);</script><div title={await p}></div>`,
			`<script>let p = Promise.resolve([]);</script>{#each await p as x}{x}{/each}`,
			`<script>let p = Promise.resolve(1);</script>{#snippet s()}{await p}{/snippet}`
		],
		fine: [
			`<script module>let x = await fetch('a');</script>`,
			`<script>async function f() { await 1 }</script>`,
			`<script>let p = Promise.resolve(1);</script><button onclick={async () => await p}>x</button>`,
			`<script>let p = Promise.resolve(1); let d = $derived.by(async () => await p);</script>`,
			`<script>let p = Promise.resolve(1);</script>{#await p}x{:then v}{v}{/await}`
		]
	},
	options_custom_renderer: {
		found: [`<svelte:options customRenderer="./renderer.js" /><p>x</p>`],
		fine: [`<svelte:options namespace="svg" /><g></g>`]
	}
};

describe('rules', () => {
	test('every rule has cases', () => {
		expect(Object.keys(cases).sort()).toEqual(RULES.map((rule) => rule.code).sort());
	});

	for (const [code, { found, fine }] of Object.entries(cases)) {
		describe(code, () => {
			for (const source of found) {
				test(`finds ${source}`, () => {
					expect(rules(source)).toEqual([code]);
				});
			}

			for (const source of fine) {
				test(`finds nothing in ${source}`, () => {
					expect(rules(source)).toEqual([]);
				});
			}
		});
	}

	test('every rule says what was found and what to write instead', () => {
		const sources = Object.values(cases).flatMap(({ found }) => found);

		for (const finding of sources.flatMap((source) => check(source))) {
			expect(finding.found.length).toBeGreaterThan(0);
			expect(finding.instead.length).toBeGreaterThan(0);
		}
	});
});

describe('check', () => {
	test('says what to do in place of the modifiers of an `on:` directive', () => {
		const [finding] = check(`<form on:submit|capture|preventDefault={() => {}}></form>`);

		expect(finding.found).toBe('`on:submit|capture|preventDefault`, an `on:` directive');
		expect(finding.instead).toBe(
			'use the `onsubmitcapture` attribute, and call `event.preventDefault()` in the handler'
		);
	});

	test('takes `<slot>` in a custom element, also one that the compiler option makes one', () => {
		expect(rules(`<slot />`)).toEqual(['slot_element']);
		expect(rules(`<slot />`, { customElement: true })).toEqual([]);
	});

	test('reports where it found something, as Svelte does', () => {
		const [finding] = check(`<script>\n\tlet a = 1;\n\texport let x;\n</script>`);

		expect(finding).toMatchObject({ rule: 'export_let', line: 3, column: 1, start: 22 });
	});

	test('returns the findings in the order of the file', () => {
		const source = `<p>{$$props.a}</p><script>export let x;</script>`;
		expect(rules(source)).toEqual(['dollar_props', 'export_let']);
	});

	test('`await` is no finding with `experimental.async`, which the server supports', () => {
		const source = `<script>let x = await fetch('a');</script>{await x}`;

		expect(rules(source)).toEqual(['await_expression', 'await_expression']);
		expect(rules(source, { async: true })).toEqual([]);
	});

	test('a file that does not parse is a finding, with the parser\'s message', () => {
		const [finding, ...rest] = check(`<p>\n{#if true}\n</p>`);

		expect(rest).toEqual([]);
		expect(finding).toMatchObject({ rule: 'parse_error', line: 3 });
		expect(finding.instead).toContain('`</p>` attempted to close an element that was not open');
	});

	test('finds nothing in a component that only uses what svelte-lite supports', () => {
		const source = `<script>
			import Child from './Child.svelte';
			let { items = [], onselect } = $props();
			let count = $state(0);
			let double = $derived(count * 2);
			$effect(() => console.log(double));
		</script>

		<svelte:window onkeydown={() => count++} />
		<button onclick={() => count++} class:big={count > 3}>{count}</button>
		{#each items as item (item.id)}<Child {item} onclick={() => onselect(item)} />{/each}
		{#snippet row(x)}<p>{x}</p>{/snippet}
		{@render row(count)}`;

		expect(check(source)).toEqual([]);
	});
});

describe('the compiler entry point', () => {
	test('rejects what the check finds, naming the file and position', () => {
		expect(() =>
			compile(`<svelte:options runes={false} /><p>x</p>`, { filename: 'App.svelte', generate: 'client' })
		).toThrow(
			'svelte-lite does not support `runes={false}` in `<svelte:options>`, which selects legacy mode ' +
				'(App.svelte:1:17): remove it'
		);
	});

	test('rejects it when compiling for the server as well', () => {
		expect(() =>
			compile(`<svelte:options runes={false} /><p>x</p>`, { filename: 'App.svelte', generate: 'server' })
		).toThrow('svelte-lite does not support `runes={false}`');
	});

	test('leaves what Svelte\'s compiler rejects to it', () => {
		expect(() => compile(`<script>export let x;</script>`, { generate: 'client' })).toThrow(
			'Cannot use `export let` in runes mode'
		);
	});

	test('compiles what the check finds nothing in', () => {
		const source = `<script>let n = $state(0);</script><button onclick={() => n++}>{n}</button>`;
		expect(compile(source, {}).js.code).toContain('$.state(0)');
	});
});

describe('the command line', () => {
	const cli = path.join(import.meta.dir, 'cli.ts');
	const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-lite-check-'));
	fs.mkdirSync(path.join(dir, 'src/lib'), { recursive: true });
	fs.mkdirSync(path.join(dir, 'node_modules/lib'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'src/Fine.svelte'), `<script>let n = $state(0);</script><p>{n}</p>`);
	fs.writeFileSync(path.join(dir, 'src/lib/Old.svelte'), `<script>\n\texport let x;\n</script>\n{$$props.y}`);
	fs.writeFileSync(path.join(dir, 'src/lib/notes.txt'), `export let x;`);
	fs.writeFileSync(path.join(dir, 'node_modules/lib/Old.svelte'), `<script>export let x;</script>`);

	test('prints a line per finding and exits with 1', () => {
		const result = run(path.join(dir, 'src'));
		const lines = result.stdout.trim().split('\n');

		expect(result.status).toBe(1);
		expect(lines).toEqual([
			`${path.join(dir, 'src/lib/Old.svelte')}:2:2  \`export let\`, which declares a prop in legacy mode: ` +
				'declare props with `$props()`: `let { x } = $props()`',
			`${path.join(dir, 'src/lib/Old.svelte')}:4:2  \`$$props\`, which only legacy mode has: ` +
				'take the props from `$props()`: `let props = $props()`'
		]);
		expect(result.stderr).toContain('2 findings in 2 files checked');
	});

	test('skips node_modules, and takes files as well as directories', () => {
		expect(run(path.join(dir, 'node_modules/lib/Old.svelte')).status).toBe(1);
		expect(run(dir).stdout).not.toContain('node_modules');
	});

	test('exits with 0 when there is nothing to report', () => {
		const result = run(path.join(dir, 'src/Fine.svelte'));

		expect(result.status).toBe(0);
		expect(result.stdout).toBe('');
	});
});
