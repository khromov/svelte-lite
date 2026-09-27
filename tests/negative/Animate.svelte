<script>
	import { flip } from 'svelte/animate';
	let items = $state([1, 2, 3]);
</script>

{#each items as item (item)}<p animate:flip>{item}</p>{/each}
