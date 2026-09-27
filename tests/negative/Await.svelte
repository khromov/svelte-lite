<script>
	let p = $state(Promise.resolve('x'));
</script>

<p>{await p}</p>
