<script>
	// Verification app for the riskiest `minimal` patches: stores in runes mode
	// (legacy_updates removal, mutable_source kept in each.js) and $effect.pre writing state
	// while effects are being traversed.
	import { writable, derived } from 'svelte/store';

	const count = writable(0);
	const doubled = derived(count, (n) => n * 2);
	const items = writable([{ id: 1, name: 'a' }]);

	let mirror = $state(0);

	$effect.pre(() => {
		mirror = $count * 10;
	});
</script>

<button id="inc" onclick={() => count.update((n) => n + 1)}>count {$count}</button>
<p id="doubled">doubled {$doubled}</p>
<p id="mirror">mirror {mirror}</p>
<ul id="items">
	{#each $items as item (item.id)}<li>{item.name}</li>{/each}
</ul>
<button
	id="rename"
	onclick={() =>
		items.update((list) => {
			list[0].name = list[0].name + '!';
			return list;
		})}>rename</button
>
