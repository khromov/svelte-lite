<script>
	// $bindable prop, defaults, callback prop, rest props (incl. attachments) spread onto an
	// element, $props.id(), and an exported function reached through bind:this
	let { value = $bindable(0), step = 1, label = 'counter', onchange, ...rest } = $props();
	const uid = $props.id();

	export function reset() {
		value = 0;
	}
</script>

<label class="counter-label" for="{uid}-btn">{label}</label>
<button
	id="{uid}-btn"
	class="counter"
	{...rest}
	onclick={() => {
		value += step;
		onchange?.(value);
	}}>{label}: {value}</button
>
