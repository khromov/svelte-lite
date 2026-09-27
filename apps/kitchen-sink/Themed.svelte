<script>
	// context consumers: getContext (reactive object), createContext getter, hasContext, getAllContexts
	import { getAllContexts, getContext, hasContext } from 'svelte';
	import { getUser, hasUser } from './context.js';

	const theme = getContext('theme');
	const user = getUser();
	const contexts = getAllContexts();
</script>

<p id="themed" style:color={theme.color}>
	{theme.color} / {user.name} / has user: {hasUser()} / has missing: {hasContext('missing')} / contexts: {contexts.size}
</p>
