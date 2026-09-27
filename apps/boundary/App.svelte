<script>
	// Error boundary (the parts of Boundary that `minimal` keeps) inside a hydrated app
	let count = $state(0);
	let broken = $state(false);
	let last = $state('none');

	function explode() {
		throw new Error('boom');
	}
</script>

<button id="count" onclick={() => count++}>clicks: {count}</button>

<svelte:boundary onerror={(error) => (last = error.message)}>
	<p id="ok">fine {count}</p>
	{#if broken}<p>{explode()}</p>{/if}

	{#snippet failed(error, reset)}
		<p id="failed">failed: {error.message}</p>
		<button
			id="retry"
			onclick={() => {
				broken = false;
				reset();
			}}>retry</button
		>
	{/snippet}
</svelte:boundary>

<button id="break" onclick={() => (broken = true)}>break</button>
<p id="last">last error: {last}</p>
