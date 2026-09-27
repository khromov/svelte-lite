<script>
	// named snippet props with arguments, optional children, a prop default, scoped CSS that
	// reads a --custom-property passed from the parent (<Card --accent="…">)
	let { title = 'Untitled', header, children, footer } = $props();
</script>

<article class="card">
	<header>
		{#if header}{@render header(title)}{:else}<h3 class="default-header">{title}</h3>{/if}
	</header>
	{@render children?.()}
	{#if footer}<footer>{@render footer(title.length)}</footer>{/if}
</article>

<style>
	.card {
		border: 1px solid var(--accent, gray);
	}
	.card :global(.card-body) {
		padding: 4px;
	}
</style>
