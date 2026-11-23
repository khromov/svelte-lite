// Feature matrix: each scenario = the "counter" baseline + exactly one feature.
// Delta vs `counter` (or vs `static` where noted) = marginal cost of that feature when used.

const R = { runes: true };
const A = { runes: true, experimental: { async: true } };

const COUNTER = `<script>let count = $state(0);</script><button onclick={() => count++}>clicks: {count}</button>`;

/** build an App that has the counter plus extra script/markup */
const app = (script = '', markup = '', head = '') =>
	`${head}<script>${script}\nlet count = $state(0);</script><button onclick={() => count++}>clicks: {count}</button>\n${markup}`;

const s = (name, files, compilerOptions = R, entry) => ({ name, files, compilerOptions, ...(entry ? { entry } : {}) });

const CHILD = `<script>let { value } = $props();</script><p>{value}</p>`;

export default [
	// ---------------- floors ----------------
	s('empty-entry', { 'App.svelte': '' }, R, `import 'svelte';`),
	s('static', { 'App.svelte': '<h1>Hello</h1>' }),
	s('static-text-expr', { 'App.svelte': `<script>let name = 'x';</script><h1>Hello {name}</h1>` }),
	s('counter', { 'App.svelte': COUNTER }),
	s('counter+hydrate', { 'App.svelte': COUNTER }, R, `import { hydrate } from 'svelte'; import App from './App.svelte'; hydrate(App, { target: document.body });`),
	s('counter+mount+unmount', { 'App.svelte': COUNTER }, R, `import { mount, unmount } from 'svelte'; import App from './App.svelte'; const a = mount(App, { target: document.body }); unmount(a, { outro: true });`),
	s('counter+async-flag', { 'App.svelte': COUNTER }, A),

	// ---------------- reactivity ----------------
	s('derived', { 'App.svelte': app('', '', '').replace('let count = $state(0);', 'let count = $state(0); let double = $derived(count * 2);').replace('{count}</button>', '{count} {double}</button>') }),
	s('derived.by', { 'App.svelte': app(`let d = $derived.by(() => { return count * 2 });`, `<p>{d}</p>`) }),
	s('effect', { 'App.svelte': app(`$effect(() => { console.log(count) });`) }),
	s('effect.pre', { 'App.svelte': app(`$effect.pre(() => { console.log(count) });`) }),
	s('effect.root', { 'App.svelte': app(`const c = $effect.root(() => { $effect(() => console.log(count)) }); c();`) }),
	s('effect.tracking', { 'App.svelte': app(`console.log($effect.tracking());`) }),
	s('state-object-proxy', { 'App.svelte': app(`let obj = $state({ a: { b: 1 }, list: [1,2] });`, `<p>{obj.a.b} {obj.list.length}</p><button onclick={() => obj.list.push(3)}>push</button>`) }),
	s('state.raw', { 'App.svelte': app(`let raw = $state.raw({ a: 1 });`, `<p>{raw.a}</p><button onclick={() => raw = { a: 2 }}>x</button>`) }),
	s('state.snapshot', { 'App.svelte': app(`let obj = $state({ a: 1 }); console.log($state.snapshot(obj));`) }),
	s('state.eager', { 'App.svelte': app(`let e = $derived($state.eager(count));`, `<p>{e}</p>`) }),
	s('class-state-fields', { 'App.svelte': app(`class Counter { n = $state(0); d = $derived(this.n * 2); inc() { this.n++ } } const c = new Counter();`, `<button onclick={() => c.inc()}>{c.n} {c.d}</button>`) }),
	s('untrack', { 'App.svelte': app(`import { untrack } from 'svelte'; $effect(() => { untrack(() => count) });`) }),
	s('tick', { 'App.svelte': app(`import { tick } from 'svelte'; tick().then(() => {});`) }),
	s('flushSync', { 'App.svelte': app(`import { flushSync } from 'svelte'; function f() { count++; flushSync(); }`, `<button onclick={f}>f</button>`) }),
	s('settled', { 'App.svelte': app(`import { settled } from 'svelte'; settled().then(() => {});`) }),
	s('fork', { 'App.svelte': app(`import { fork } from 'svelte'; const f = fork(() => { count++ }); f.commit();`) }, A),
	s('getAbortSignal', { 'App.svelte': app(`import { getAbortSignal } from 'svelte'; let d = $derived.by(() => { getAbortSignal(); return count; });`, `<p>{d}</p>`) }),
	s('inspect (stripped in prod)', { 'App.svelte': app(`$inspect(count);`) }),

	// ---------------- components / props / context ----------------
	s('child-component+props', { 'App.svelte': app(`import Child from './Child.svelte';`, `<Child value={count} />`), 'Child.svelte': CHILD }),
	s('props-bindable', { 'App.svelte': app(`import Child from './Child.svelte';`, `<Child bind:value={count} />`), 'Child.svelte': `<script>let { value = $bindable() } = $props();</script><button onclick={() => value++}>{value}</button>` }),
	s('props-rest', { 'App.svelte': app(`import Child from './Child.svelte';`, `<Child value={count} other="x" />`), 'Child.svelte': `<script>let { value, ...rest } = $props();</script><p {...rest}>{value}</p>` }),
	s('props-default-fallback', { 'App.svelte': app(`import Child from './Child.svelte';`, `<Child />`), 'Child.svelte': `<script>let { value = 5 } = $props();</script><p>{value}</p>` }),
	s('props.id', { 'App.svelte': app(`const uid = $props.id();`, `<p id={uid}>x</p>`) }),
	s('spread-props-to-component', { 'App.svelte': app(`import Child from './Child.svelte'; let p = $state({ value: 1 });`, `<Child {...p} />`), 'Child.svelte': CHILD }),
	s('context', { 'App.svelte': app(`import { setContext, getContext } from 'svelte'; setContext('k', 1); getContext('k');`) }),
	s('createContext', { 'App.svelte': app(`import { createContext } from 'svelte'; const [get, set] = createContext(); set(1); get();`) }),
	s('onMount', { 'App.svelte': app(`import { onMount } from 'svelte'; onMount(() => { console.log('m') });`) }),
	s('onDestroy', { 'App.svelte': app(`import { onDestroy } from 'svelte'; onDestroy(() => { console.log('d') });`) }),
	s('dynamic-component', { 'App.svelte': app(`import Child from './Child.svelte'; let C = $state(Child);`, `<C value={count} />`), 'Child.svelte': CHILD }),
	s('svelte:component (legacy syntax, runes)', { 'App.svelte': app(`import Child from './Child.svelte'; let C = $state(Child);`, `<svelte:component this={C} value={count} />`), 'Child.svelte': CHILD }),
	s('svelte:self-like recursion', { 'App.svelte': app(`import Tree from './Tree.svelte';`, `<Tree depth={2} />`), 'Tree.svelte': `<script>import Tree from './Tree.svelte'; let { depth } = $props();</script>{#if depth > 0}<Tree depth={depth - 1} />{/if}` }),

	// ---------------- control flow ----------------
	s('if', { 'App.svelte': app('', `{#if count > 1}<p>big</p>{/if}`) }),
	s('if-else-if', { 'App.svelte': app('', `{#if count > 5}<p>a</p>{:else if count > 2}<p>b</p>{:else}<p>c</p>{/if}`) }),
	s('each-unkeyed', { 'App.svelte': app(`let items = $state([1,2,3]);`, `{#each items as item}<li>{item}</li>{/each}`) }),
	s('each-keyed', { 'App.svelte': app(`let items = $state([{id:1},{id:2}]);`, `{#each items as item (item.id)}<li>{item.id}</li>{/each}`) }),
	s('each-index', { 'App.svelte': app(`let items = $state([1,2,3]);`, `{#each items as item, i}<li>{i}:{item}</li>{/each}`) }),
	s('each-else', { 'App.svelte': app(`let items = $state([1,2,3]);`, `{#each items as item}<li>{item}</li>{:else}<p>none</p>{/each}`) }),
	s('each-destructure', { 'App.svelte': app(`let items = $state([{a:1}]);`, `{#each items as { a }}<li>{a}</li>{/each}`) }),
	s('each-bind-item', { 'App.svelte': app(`let items = $state([{v:'a'}]);`, `{#each items as item}<input bind:value={item.v} />{/each}`) }),
	s('await', { 'App.svelte': app(`let p = $state(Promise.resolve(1));`, `{#await p}<p>loading</p>{:then v}<p>{v}</p>{:catch e}<p>{e}</p>{/await}`) }),
	s('key', { 'App.svelte': app('', `{#key count}<p>k</p>{/key}`) }),
	s('snippet+render', { 'App.svelte': app('', `{#snippet s(x)}<b>{x}</b>{/snippet}{@render s(count)}`) }),
	s('snippet-as-prop', { 'App.svelte': app(`import Child from './Child.svelte';`, `<Child>{#snippet header()}<h1>h</h1>{/snippet}<p>body</p></Child>`), 'Child.svelte': `<script>let { header, children } = $props();</script>{@render header?.()}{@render children?.()}` }),
	s('dynamic-snippet', { 'App.svelte': app(`import { createRawSnippet } from 'svelte';`, `{#snippet a()}<b>a</b>{/snippet}{#snippet b()}<i>b</i>{/snippet}{@render (count ? a : b)()}`) }),
	s('createRawSnippet', { 'App.svelte': app(`import { createRawSnippet } from 'svelte'; const r = createRawSnippet(() => ({ render: () => '<b>x</b>' }));`, `{@render r()}`) }),
	s('html', { 'App.svelte': app(`let h = $state('<b>x</b>');`, `{@html h}`) }),
	s('const-tag', { 'App.svelte': app(`let items = $state([1,2]);`, `{#each items as item}{@const d = item * 2}<li>{d}</li>{/each}`) }),
	s('boundary-failed', { 'App.svelte': app('', `<svelte:boundary>{#snippet failed(e, reset)}<button onclick={reset}>retry</button>{/snippet}<p>{count}</p></svelte:boundary>`) }),
	s('boundary-onerror', { 'App.svelte': app('', `<svelte:boundary onerror={(e) => console.log(e)}><p>{count}</p></svelte:boundary>`) }),

	// ---------------- async ----------------
	s('async-await-in-template', { 'App.svelte': app(`async function load(n) { return n }`, `<p>{await load(count)}</p>`) }, A),
	s('async-derived', { 'App.svelte': app(`async function load(n) { return n } let d = $derived(await load(count));`, `<p>{d}</p>`) }, A),
	s('async-boundary-pending', { 'App.svelte': app(`async function load(n) { return n }`, `<svelte:boundary><p>{await load(count)}</p>{#snippet pending()}<p>...</p>{/snippet}</svelte:boundary>`) }, A),
	s('async-top-level-await', { 'App.svelte': `<script>const data = await Promise.resolve(1);</script><p>{data}</p>` }, A),

	// ---------------- elements: attributes / class / style ----------------
	s('dynamic-attribute', { 'App.svelte': app('', `<a href="/{count}" title={count}>a</a>`) }),
	s('boolean-attribute', { 'App.svelte': app('', `<input disabled={count > 1} />`) }),
	s('spread-attributes', { 'App.svelte': app(`let attrs = $state({ title: 'x', class: 'y' });`, `<div {...attrs}>a</div>`) }),
	s('class-attr-dynamic', { 'App.svelte': app('', `<div class="a {count ? 'b' : ''}">a</div>`) }),
	s('class-object-clsx', { 'App.svelte': app('', `<div class={{ active: count > 1, big: true }}>a</div>`) }),
	s('class-directive', { 'App.svelte': app('', `<div class:active={count > 1}>a</div>`) }),
	s('style-attr-dynamic', { 'App.svelte': app('', `<div style="color: {count ? 'red' : 'blue'}">a</div>`) }),
	s('style-directive', { 'App.svelte': app('', `<div style:color={count ? 'red' : 'blue'}>a</div>`) }),
	s('css-custom-props-on-component', { 'App.svelte': app(`import Child from './Child.svelte';`, `<Child value={1} --color="red" />`), 'Child.svelte': CHILD }),
	s('svelte:element', { 'App.svelte': app(`let tag = $state('div');`, `<svelte:element this={tag}>x</svelte:element>`) }),
	s('svg-element', { 'App.svelte': app('', `<svg><circle r={count} /></svg>`) }),
	s('mathml-element', { 'App.svelte': app('', `<math><mi>{count}</mi></math>`) }),
	s('autofocus', { 'App.svelte': app('', `<input autofocus />`) }),
	s('input-value-attr', { 'App.svelte': app('', `<input value={count} />`) }),
	s('textarea-value', { 'App.svelte': app('', `<textarea value={count}></textarea>`) }),
	s('select-value-attr', { 'App.svelte': app('', `<select value={count}><option value={1}>1</option></select>`) }),
	s('customizable-select', { 'App.svelte': app('', `<select><button><selectedcontent></selectedcontent></button><option value={1}><b>{count}</b></option></select>`) }),
	s('css-injected', { 'App.svelte': app('', `<style>button { color: red }</style>`) }, { runes: true, css: 'injected' }),
	s('scoped-css-external', { 'App.svelte': app('', `<style>button { color: red }</style>`) }),

	// ---------------- events ----------------
	s('event-non-delegated', { 'App.svelte': app('', `<div onscroll={() => count++}>x</div>`) }),
	s('event-handler-spread', { 'App.svelte': app(`let handlers = { onclick: () => count++ };`, `<div {...handlers}>x</div>`) }),
	s('events-on()', { 'App.svelte': app(`import { on } from 'svelte/events'; on(window, 'resize', () => count++);`) }),
	s('svelte:window-event', { 'App.svelte': app('', `<svelte:window onkeydown={() => count++} />`) }),
	s('svelte:document-event', { 'App.svelte': app('', `<svelte:document onvisibilitychange={() => count++} />`) }),
	s('svelte:body-event', { 'App.svelte': app('', `<svelte:body onmouseenter={() => count++} />`) }),
	s('svelte:head', { 'App.svelte': app('', `<svelte:head><title>{count}</title></svelte:head>`) }),

	// ---------------- bindings ----------------
	s('bind:value-input', { 'App.svelte': app(`let v = $state('');`, `<input bind:value={v} />`) }),
	s('bind:value-number', { 'App.svelte': app(`let v = $state(0);`, `<input type="number" bind:value={v} />`) }),
	s('bind:checked', { 'App.svelte': app(`let v = $state(false);`, `<input type="checkbox" bind:checked={v} />`) }),
	s('bind:group', { 'App.svelte': app(`let v = $state([]);`, `<input type="checkbox" value="a" bind:group={v} /><input type="checkbox" value="b" bind:group={v} />`) }),
	s('bind:files', { 'App.svelte': app(`let v = $state();`, `<input type="file" bind:files={v} />`) }),
	s('bind:value-select', { 'App.svelte': app(`let v = $state('a');`, `<select bind:value={v}><option>a</option><option>b</option></select>`) }),
	s('bind:this', { 'App.svelte': app(`let el = $state();`, `<div bind:this={el}>x</div>`) }),
	s('bind:this-component', { 'App.svelte': app(`import Child from './Child.svelte'; let c = $state();`, `<Child bind:this={c} value={1} />`), 'Child.svelte': CHILD }),
	s('bind:clientWidth', { 'App.svelte': app(`let w = $state(0);`, `<div bind:clientWidth={w}>{w}</div>`) }),
	s('bind:contentRect', { 'App.svelte': app(`let r = $state();`, `<div bind:contentRect={r}>x</div>`) }),
	s('bind:innerHTML-contenteditable', { 'App.svelte': app(`let h = $state('');`, `<div contenteditable bind:innerHTML={h}></div>`) }),
	s('bind:media', { 'App.svelte': app(`let t = $state(0); let p = $state(true);`, `<video bind:currentTime={t} bind:paused={p}></video>`) }),
	s('bind:window', { 'App.svelte': app(`let w = $state(0); let y = $state(0);`, `<svelte:window bind:innerWidth={w} bind:scrollY={y} />`) }),
	s('bind:document-activeElement', { 'App.svelte': app(`let a = $state();`, `<svelte:document bind:activeElement={a} />`) }),
	s('bind:function-get-set', { 'App.svelte': app(`let v = $state('');`, `<input bind:value={() => v, (x) => v = x} />`) }),
	s('bind:focused', { 'App.svelte': app(`let f = $state(false);`, `<input bind:focused={f} />`) }),

	// ---------------- actions / attachments ----------------
	s('use:action', { 'App.svelte': app(`function act(node, p) { return { update() {}, destroy() {} } }`, `<div use:act={count}>x</div>`) }),
	s('attach', { 'App.svelte': app(`function att(node) { return () => {} }`, `<div {@attach att}>x</div>`) }),

	// ---------------- transitions / animations ----------------
	s('transition:fade', { 'App.svelte': app(`import { fade } from 'svelte/transition';`, `{#if count > 1}<p transition:fade>x</p>{/if}`) }),
	s('in:/out:', { 'App.svelte': app(`import { fly, fade } from 'svelte/transition';`, `{#if count > 1}<p in:fly={{ y: 10 }} out:fade>x</p>{/if}`) }),
	s('transition-custom-css', { 'App.svelte': app(`function t(node) { return { duration: 100, css: (t) => 'opacity:' + t } }`, `{#if count > 1}<p transition:t>x</p>{/if}`) }),
	s('transition-custom-tick', { 'App.svelte': app(`function t(node) { return { duration: 100, tick: (t) => {} } }`, `{#if count > 1}<p transition:t>x</p>{/if}`) }),
	s('transition:global', { 'App.svelte': app(`import { fade } from 'svelte/transition';`, `{#if count > 1}<p transition:fade|global>x</p>{/if}`) }),
	s('animate:flip', { 'App.svelte': app(`import { flip } from 'svelte/animate'; let items = $state([{id:1},{id:2}]);`, `{#each items as item (item.id)}<li animate:flip>{item.id}</li>{/each}`) }),
	s('transition-all-builtins', { 'App.svelte': app(`import { fade, fly, slide, scale, blur, draw, crossfade } from 'svelte/transition'; const [send, receive] = crossfade({});`, `{#if count > 1}<p transition:fade>x</p><p transition:fly>x</p><p transition:slide>x</p><p transition:scale>x</p><p transition:blur>x</p><p in:send={{key:1}} out:receive={{key:1}}>x</p>{/if}`) }),

	// ---------------- library modules ----------------
	s('svelte/store-writable+$store', { 'App.svelte': app(`import { writable } from 'svelte/store'; const s = writable(0);`, `<p>{$s}</p><button onclick={() => $s++}>x</button>`) }),
	s('svelte/store-derived+get', { 'App.svelte': app(`import { writable, derived, get, readable } from 'svelte/store'; const s = writable(0); const d = derived(s, (x) => x * 2); console.log(get(d));`) }),
	s('svelte/store-fromStore/toStore', { 'App.svelte': app(`import { fromStore, toStore, writable } from 'svelte/store'; const f = fromStore(writable(0)); const t = toStore(() => count);`, `<p>{f.current}</p>`) }),
	s('SvelteMap', { 'App.svelte': app(`import { SvelteMap } from 'svelte/reactivity'; const m = new SvelteMap();`, `<p>{m.size}</p>`) }),
	s('SvelteSet', { 'App.svelte': app(`import { SvelteSet } from 'svelte/reactivity'; const m = new SvelteSet();`, `<p>{m.size}</p>`) }),
	s('SvelteDate', { 'App.svelte': app(`import { SvelteDate } from 'svelte/reactivity'; const d = new SvelteDate();`, `<p>{d.getTime()}</p>`) }),
	s('SvelteURL', { 'App.svelte': app(`import { SvelteURL } from 'svelte/reactivity'; const u = new SvelteURL('http://a');`, `<p>{u.href}</p>`) }),
	s('MediaQuery', { 'App.svelte': app(`import { MediaQuery } from 'svelte/reactivity'; const m = new MediaQuery('(min-width: 1px)');`, `<p>{m.current}</p>`) }),
	s('createSubscriber', { 'App.svelte': app(`import { createSubscriber } from 'svelte/reactivity'; const sub = createSubscriber(() => () => {}); const g = () => { sub(); return 1 };`, `<p>{g()}</p>`) }),
	s('reactivity/window', { 'App.svelte': app(`import { innerWidth, online } from 'svelte/reactivity/window';`, `<p>{innerWidth.current} {online.current}</p>`) }),
	s('motion-Tween', { 'App.svelte': app(`import { Tween } from 'svelte/motion'; const t = new Tween(0);`, `<p>{t.current}</p>`) }),
	s('motion-Spring', { 'App.svelte': app(`import { Spring } from 'svelte/motion'; const t = new Spring(0);`, `<p>{t.current}</p>`) }),
	s('motion-prefersReducedMotion', { 'App.svelte': app(`import { prefersReducedMotion } from 'svelte/motion';`, `<p>{prefersReducedMotion.current}</p>`) }),
	s('easing-cubicOut', { 'App.svelte': app(`import { cubicOut } from 'svelte/easing'; console.log(cubicOut(0.5));`) }),

	// ---------------- legacy / compat ----------------
	s('legacy-mode-component', { 'App.svelte': `<script>let count = 0;</script><button on:click={() => count++}>clicks: {count}</button>` }, { runes: false }),
	s('legacy-$:', { 'App.svelte': `<script>let count = 0; $: double = count * 2;</script><button on:click={() => count++}>clicks: {count} {double}</button>` }, { runes: false }),
	s('legacy-export-let', { 'App.svelte': `<script>import Child from './Child.svelte'; let count = 0;</script><button on:click={() => count++}>clicks: {count}</button><Child value={count} />`, 'Child.svelte': `<script>export let value;</script><p>{value}</p>` }, { runes: false }),
	s('legacy-slots', { 'App.svelte': `<script>import Child from './Child.svelte'; let count = 0;</script><button on:click={() => count++}>clicks: {count}</button><Child><p slot="a">x</p>default</Child>`, 'Child.svelte': `<slot name="a" /><slot />` }, { runes: false }),
	s('legacy-createEventDispatcher', { 'App.svelte': `<script>import Child from './Child.svelte'; let count = 0;</script><button on:click={() => count++}>clicks: {count}</button><Child on:x={() => count++} />`, 'Child.svelte': `<script>import { createEventDispatcher } from 'svelte'; const d = createEventDispatcher();</script><button on:click={() => d('x')}>x</button>` }, { runes: false }),
	s('legacy-event-modifiers', { 'App.svelte': `<script>let count = 0;</script><button on:click|preventDefault|stopPropagation|once={() => count++}>clicks: {count}</button>` }, { runes: false }),
	s('legacy-beforeUpdate/afterUpdate', { 'App.svelte': `<script>import { beforeUpdate, afterUpdate } from 'svelte'; let count = 0; beforeUpdate(() => {}); afterUpdate(() => {});</script><button on:click={() => count++}>clicks: {count}</button>` }, { runes: false }),
	s('legacy-$$props/$$restProps', { 'App.svelte': `<script>import Child from './Child.svelte'; let count = 0;</script><button on:click={() => count++}>clicks: {count}</button><Child a={1} b={2} />`, 'Child.svelte': `<script>export let a;</script><p {...$$restProps}>{a} {$$props.b}</p>` }, { runes: false }),
	s('legacy-reactive-store', { 'App.svelte': `<script>import { writable } from 'svelte/store'; const s = writable(0);</script><button on:click={() => $s++}>clicks: {$s}</button>` }, { runes: false }),
	s('legacy-createClassComponent', { 'App.svelte': COUNTER }, R, `import { createClassComponent } from 'svelte/legacy'; import App from './App.svelte'; createClassComponent({ component: App, target: document.body });`),
	s('legacy-run/handlers (svelte/legacy)', { 'App.svelte': app(`import { run, preventDefault } from 'svelte/legacy'; run(() => { console.log(count) });`, `<form onsubmit={preventDefault(() => count++)}></form>`) }),

	// ---------------- custom elements ----------------
	s('custom-element', { 'App.svelte': `<svelte:options customElement="my-counter" />` + COUNTER }, { runes: true, customElement: true }, `import './App.svelte';`),
	s('custom-element-props', { 'App.svelte': `<svelte:options customElement="my-counter" /><script>let { value = 0 } = $props();</script><button onclick={() => value++}>{value}</button>` }, { runes: true, customElement: true }, `import './App.svelte';`),

	// ---------------- tracing flag ----------------
	s('inspect.trace (prod)', { 'App.svelte': app(`$effect(() => { $inspect.trace(); console.log(count) });`) })
];
