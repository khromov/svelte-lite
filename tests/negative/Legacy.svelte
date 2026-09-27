<script>
	export let name = 'world';
	$: upper = name.toUpperCase();
</script>

<p>{upper}</p>
