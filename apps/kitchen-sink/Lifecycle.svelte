<script>
	// onMount (with a cleanup return), onDestroy, and $effect teardown when an {#if} removes us
	import { onDestroy, onMount } from 'svelte';

	let { log } = $props();
	let mounted = $state(false);

	onMount(() => {
		mounted = true;
		log('mount');
		return () => log('mount cleanup');
	});
	onDestroy(() => log('destroy'));
	$effect(() => () => log('effect teardown'));
</script>

<p id="lifecycle">mounted: {mounted}</p>
