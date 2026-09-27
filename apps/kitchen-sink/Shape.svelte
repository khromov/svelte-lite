<svelte:options namespace="svg" />

<script>
	// a component rendered inside <svg>: its elements must be created in the SVG namespace
	let { size } = $props();
</script>

<rect id="shape-rect" x="0" y="0" width={size} height={size} />
