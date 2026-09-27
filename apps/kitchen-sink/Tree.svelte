<script>
	// recursive component via a self-import (replaces <svelte:self>)
	import Tree from './Tree.svelte';

	let { node, depth = 0 } = $props();
</script>

<li class="tree-node" data-depth={depth}>
	{node.name}
	{#if node.children?.length}
		<ul>
			{#each node.children as child (child.name)}
				<Tree node={child} depth={depth + 1} />
			{/each}
		</ul>
	{/if}
</li>
