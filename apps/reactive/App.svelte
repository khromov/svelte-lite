<script>
	import Child from './Child.svelte';

	let count = $state(0);
	let doubled = $derived(count * 2);
	let name = $state('world');
	let settings = $state({ color: 'red' });
	let items = $state([
		{ id: 1, text: 'one', done: false },
		{ id: 2, text: 'two', done: false }
	]);
	let next_id = 3;

	function add() {
		items.push({ id: next_id, text: `item ${next_id}`, done: false });
		next_id += 1;
	}

	function remove(id) {
		items.splice(
			items.findIndex((item) => item.id === id),
			1
		);
	}

	function reset() {
		// assigning a fresh array to $state: compiles to $.set(items, [...], true)
		items = [{ id: 100, text: 'fresh', done: false }];
	}
</script>

{#snippet badge(text)}
	<span class="badge">{text}</span>
{/snippet}

<button id="inc" onclick={() => count++}>count: {count}</button>
<p id="doubled">doubled: {doubled}</p>

{#if count % 2 === 0}
	<p id="parity">even</p>
{:else}
	<p id="parity">odd</p>
{/if}

<div id="box" class:active={count > 0} style:color={settings.color}>box</div>
<button id="color" onclick={() => (settings.color = settings.color === 'red' ? 'blue' : 'red')}>
	color
</button>

<input id="name" bind:value={name} />
<p id="greeting">Hello {name}!</p>

<ul id="list">
	{#each items as item (item.id)}
		<li class:done={item.done}>
			<span class="text">{item.text}</span>
			<button class="toggle" onclick={() => (item.done = !item.done)}>toggle</button>
			<button class="remove" onclick={() => remove(item.id)}>remove</button>
		</li>
	{/each}
</ul>
<button id="add" onclick={add}>add</button>
<button id="reset" onclick={reset}>reset</button>

{@render badge('in-app')}

<Child {count} label="child">
	{@render badge('from-parent')}
</Child>
