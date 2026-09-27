<script>
	let { count, label, children } = $props();
</script>

<div id="child">
	<span id="child-count">{label}: {count}</span>
	{@render children?.()}
</div>
