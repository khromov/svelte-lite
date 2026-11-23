// Realistic multi-feature apps: what a typical small SPA uses.
const R = { runes: true };

const TODO_ITEM = `<script>
	let { todo, onremove } = $props();
	let editing = $state(false);
</script>
<li class:done={todo.done} class:editing>
	<input type="checkbox" bind:checked={todo.done} />
	{#if editing}
		<input bind:value={todo.text} onblur={() => (editing = false)} />
	{:else}
		<span ondblclick={() => (editing = true)}>{todo.text}</span>
	{/if}
	<button onclick={() => onremove(todo)}>x</button>
</li>`;

const APP = `<script>
	import { onMount } from 'svelte';
	import Item from './Item.svelte';
	import Header from './Header.svelte';
	let todos = $state([{ id: 1, text: 'a', done: false }]);
	let filter = $state('all');
	let text = $state('');
	let visible = $derived(todos.filter((t) => filter === 'all' || (filter === 'done') === t.done));
	let remaining = $derived(todos.filter((t) => !t.done).length);
	$effect(() => { localStorage.setItem('todos', JSON.stringify(todos)); });
	onMount(() => { console.log('mounted'); });
	function add(e) { e.preventDefault(); todos.push({ id: Date.now(), text, done: false }); text = ''; }
	function remove(t) { todos = todos.filter((x) => x !== t); }
</script>
<Header title="Todos" count={remaining}>
	{#snippet extra()}<small>{filter}</small>{/snippet}
</Header>
<form onsubmit={add}>
	<input bind:value={text} placeholder="what needs doing?" />
</form>
<ul>
	{#each visible as todo (todo.id)}
		<Item {todo} onremove={remove} />
	{:else}
		<p>nothing to do</p>
	{/each}
</ul>
<footer>
	{#each ['all', 'active', 'done'] as f}
		<button class={{ selected: filter === f }} onclick={() => (filter = f)}>{f}</button>
	{/each}
	<a href="/help?n={remaining}" style:color={remaining ? 'red' : 'green'}>help</a>
</footer>`;

const HEADER = `<script>
	let { title, count, extra } = $props();
</script>
<header><h1>{title} ({count})</h1>{@render extra?.()}</header>`;

export default [
	{ name: 'realistic-app', files: { 'App.svelte': APP, 'Item.svelte': TODO_ITEM, 'Header.svelte': HEADER }, compilerOptions: R },
	{
		name: 'realistic-app+transitions',
		files: {
			'App.svelte': APP.replace(`import Item from './Item.svelte';`, `import Item from './Item.svelte'; import { fade } from 'svelte/transition'; import { flip } from 'svelte/animate';`).replace(`<Item {todo} onremove={remove} />`, `<div animate:flip transition:fade><Item {todo} onremove={remove} /></div>`),
			'Item.svelte': TODO_ITEM,
			'Header.svelte': HEADER
		},
		compilerOptions: R
	},
	{
		name: 'realistic-app+hydrate',
		files: { 'App.svelte': APP, 'Item.svelte': TODO_ITEM, 'Header.svelte': HEADER },
		compilerOptions: R,
		entry: `import { hydrate } from 'svelte'; import App from './App.svelte'; hydrate(App, { target: document.body });`
	},
	{
		name: 'realistic-app+async-flag',
		files: { 'App.svelte': APP, 'Item.svelte': TODO_ITEM, 'Header.svelte': HEADER },
		compilerOptions: { runes: true, experimental: { async: true } }
	},
	{
		name: 'kitchen-sink',
		files: {
			'App.svelte': `<script>
	import { onMount, tick, untrack, setContext, getContext } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { flip } from 'svelte/animate';
	import { SvelteMap } from 'svelte/reactivity';
	import { writable } from 'svelte/store';
	import Child from './Child.svelte';
	const store = writable(0);
	let items = $state([{ id: 1 }]);
	let obj = $state({ a: 1 });
	let attrs = $state({ title: 'x' });
	let el = $state();
	let w = $state(0);
	let v = $state('');
	let p = $state(Promise.resolve(1));
	let html = $state('<b>x</b>');
	let tag = $state('div');
	const m = new SvelteMap();
	let d = $derived(items.length * 2);
	$effect(() => { console.log(d); });
	$effect.pre(() => { untrack(() => obj.a); });
	setContext('k', 1);
	onMount(() => tick());
	function act(node) { return { destroy() {} }; }
</script>
<svelte:window bind:innerWidth={w} onkeydown={() => {}} />
<svelte:head><title>{d}</title></svelte:head>
<div {...attrs} bind:this={el} use:act {@attach (n) => {}}>{$store} {m.size}</div>
<input bind:value={v} /><select bind:value={v}><option>a</option></select>
{#each items as item (item.id)}<p animate:flip transition:fade>{item.id}</p>{/each}
{#if d > 1}<p in:fly out:fade>big</p>{:else}<p>small</p>{/if}
{#await p}<p>...</p>{:then x}{x}{/await}
{#key d}<p>{d}</p>{/key}
{@html html}
<svelte:element this={tag} class:active={d > 1} style:color="red">x</svelte:element>
<svelte:boundary>{#snippet failed(e, reset)}<button onclick={reset}>r</button>{/snippet}<Child bind:value={v} {...attrs} /></svelte:boundary>`,
			'Child.svelte': `<script>let { value = $bindable(), ...rest } = $props();</script><input bind:value {...rest} />`
		},
		compilerOptions: R
	}
];
