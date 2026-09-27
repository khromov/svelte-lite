<script>
	import { fade } from 'svelte/transition';
	let show = $state(true);
</script>

{#if show}<p transition:fade>hi</p>{/if}
