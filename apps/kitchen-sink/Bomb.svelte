<script>
	// throws during render: caught by the nearest <svelte:boundary>
	let { armed } = $props();

	function check(armed) {
		if (armed) throw new Error('kaboom');
		return 'safe';
	}
</script>

<p id="bomb">{check(armed)}</p>
