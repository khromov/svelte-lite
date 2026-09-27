<script>
	// Kitchen sink: as many vanilla Svelte 5 features as the `minimal` build keeps, rendered on
	// the server and hydrated. Deliberately absent, because `minimal` drops them: legacy syntax
	// ($:, export let, on:, <slot>, createEventDispatcher, beforeUpdate/afterUpdate, svelte/legacy,
	// <svelte:component>, <svelte:self>, <svelte:fragment>), async (await expressions,
	// $effect.pending(), <svelte:boundary pending>, fork(), settled(), hydratable()), and
	// transitions/animations (transition:/in:/out:/animate:, svelte/transition, svelte/animate).
	// Also absent: mount()/unmount() (svelte-lite targets SSR + hydrate()), custom elements ($host),
	// and dev-only tooling ($inspect.trace, {@debug}).
	import { createRawSnippet, flushSync, getAbortSignal, onDestroy, setContext, tick, untrack } from 'svelte';
	import { createAttachmentKey, fromAction } from 'svelte/attachments';
	import { cubicOut } from 'svelte/easing';
	import { on } from 'svelte/events';
	import { Spring, Tween, prefersReducedMotion } from 'svelte/motion';
	import { MediaQuery, SvelteDate, SvelteMap, SvelteSet, SvelteURL, SvelteURLSearchParams } from 'svelte/reactivity';
	import { innerWidth } from 'svelte/reactivity/window';
	import { derived, fromStore, get, readable, readonly, toStore, writable } from 'svelte/store';
	import Bomb from './Bomb.svelte';
	import Card from './Card.svelte';
	import Counter from './Counter.svelte';
	import Fancy from './Fancy.svelte';
	import Lifecycle from './Lifecycle.svelte';
	import Plain from './Plain.svelte';
	import Shape from './Shape.svelte';
	import Themed from './Themed.svelte';
	import Tree from './Tree.svelte';
	import { setUser } from './context.js';
	import { Ticker, TodoList, createCounter, shared } from './state.svelte.js';

	// ---- runes
	let count = $state(0);
	let doubled = $derived(count * 2);
	let parity = $derived.by(() => {
		if (count === 0) return 'zero';
		return count % 2 ? 'odd' : 'even';
	});
	let user = $state({ name: 'Ada', langs: ['js'] });
	let { name: userName, langs } = $derived(user);
	let snapshot = $derived(JSON.stringify($state.snapshot(user)));
	let raw = $state.raw([1, 2]);
	let override = $derived(count * 10);
	let label = $state('a');
	let peek = $derived(`${label}:${untrack(() => count)}`);
	let effectLog = $state('');
	let preLog = $state('');
	let aborted = $state(0);
	let rootRuns = $state(0);
	const trackingInScript = $effect.tracking();

	$inspect(count);

	$effect(() => {
		effectLog = `effect saw ${count}`;
	});
	$effect.pre(() => {
		preLog = `pre saw ${count}`;
	});
	$effect(() => {
		count;
		getAbortSignal().addEventListener('abort', () => aborted++);
	});
	const stopRoot = $effect.root(() => {
		$effect(() => {
			count;
			untrack(() => rootRuns++);
		});
	});
	onDestroy(() => stopRoot?.());

	// ---- timing: flushSync / tick
	let flushed = $state('');
	let ticked = $state('');

	// ---- control flow
	const todos = new TodoList(['write app', 'hydrate it']);
	let newTodo = $state('');
	let keyVersion = $state(0);
	let stars = $state(3);
	let grid = $state([
		[1, 2],
		[3, 4]
	]);
	let promise = $state.raw(Promise.resolve('first'));
	let resolvePending;
	const failing = Promise.reject(new Error('nope'));
	failing.catch(() => {});

	// ---- snippets
	const tree = {
		name: 'root',
		children: [{ name: 'a', children: [{ name: 'a1' }] }, { name: 'b' }]
	};
	const rawBadge = createRawSnippet((name) => ({
		render: () => `<span class="raw-badge">raw ${name()}</span>`,
		setup(node) {
			$effect(() => {
				node.textContent = `raw ${name()}`;
			});
		}
	}));

	// ---- attributes
	let flag = $state(false);
	let color = $state('red');
	let tag = $state('div');
	let attrs = $derived({ 'data-count': count, title: `title ${count}` });

	// ---- bindings
	let text = $state('hello');
	let area = $state('multi\nline');
	let num = $state(5);
	let checked = $state(false);
	let indeterminate = $state(true);
	let flavours = $state(['a']);
	let size = $state('m');
	const options = [
		{ id: 1, label: 'one' },
		{ id: 2, label: 'two' },
		{ id: 3, label: 'three' }
	];
	let selected = $state.raw(options[1]);
	let multi = $state(['y']);
	let open = $state(false);
	let editable = $state('<i>edit me</i>');
	let width = $state();
	let volume = $state(1);
	let muted = $state(false);
	let canvas = $state();
	let counterRef = $state();
	let bound = $state(1);
	let lastChange = $state('none');
	const counterAttach = (node) => {
		node.dataset.attached = 'counter';
	};

	// ---- events
	let clicks = $state(0);
	let phases = $state([]);
	let innerClicks = $state(0);
	let outerClicks = $state(0);
	let focused = $state(false);
	let hovered = $state(false);
	let handled = $state('none');
	let spreadClicks = $state(0);
	let lastKey = $state('none');
	let winWidth = $state();
	let online = $state();
	let visibility = $state();
	let bodyClicks = $state(0);
	let pings = $state(0);
	function first() {
		handled = 'first';
		handler = second;
	}
	function second() {
		handled = 'second';
		handler = first;
	}
	let handler = $state(first);
	$effect(() => on(window, 'kitchen-ping', () => pings++));

	// ---- actions and attachments
	function tooltip(node, tip) {
		node.dataset.tip = tip;
		return {
			update(tip) {
				node.dataset.tip = tip;
			},
			destroy() {
				delete node.dataset.tip;
			}
		};
	}
	function counted(node) {
		node.dataset.count = String(count);
		return () => {
			node.dataset.cleanups = String(Number(node.dataset.cleanups ?? 0) + 1);
		};
	}
	const attachKey = createAttachmentKey();
	const attachProps = {
		class: 'keyed-attach',
		[attachKey]: (node) => {
			node.dataset.viaKey = 'yes';
		}
	};

	// ---- components and context
	let Current = $state(Fancy);
	const theme = $state({ color: 'teal' });
	setContext('theme', theme);
	setUser({ name: 'Grace' });
	let showLifecycle = $state(true);
	let lifecycleLog = $state([]);
	let armed = $state(false);
	let boundaryError = $state('none');
	const counter = createCounter(10);

	// ---- svelte/reactivity
	const scores = new SvelteMap([['ada', 1]]);
	const tags = new SvelteSet(['runes']);
	const date = new SvelteDate(2024, 0, 31);
	const url = new SvelteURL('https://example.com/path?q=1');
	const params = new SvelteURLSearchParams('a=1');
	const wide = new MediaQuery('(min-width: 600px)', false);
	const ticker = new Ticker();

	// ---- svelte/store
	const countStore = writable(1);
	const other = writable(2);
	const sum = derived([countStore, other], ([a, b]) => a + b);
	const ro = readonly(countStore);
	const started = readable('idle', (set) => {
		set('started');
	});
	const profile = writable({ name: 'Linus' });
	const fromCount = fromStore(countStore);
	let storeTarget = $state(3);
	const targetStore = toStore(
		() => storeTarget,
		(v) => (storeTarget = v)
	);
	let gotten = $state('none');

	// ---- svelte/motion + svelte/easing
	const instant = new Tween(0, { duration: 0 });
	const tween = new Tween(0, { duration: 30, easing: cubicOut });
	const spring = new Spring(0);
</script>

<svelte:head>
	<title>kitchen sink {count}</title>
	<meta name="description" content="count is {count}" />
</svelte:head>

<svelte:window onkeydown={(e) => (lastKey = e.key)} bind:innerWidth={winWidth} bind:online />
<svelte:document bind:visibilityState={visibility} />
<svelte:body onclick={() => bodyClicks++} />

{#snippet greet(name, punct = '!')}<span class="greet">Hello {name}{punct}</span>{/snippet}

{#snippet branch(n)}
	<li>
		{n.name}
		{#if n.children}<ul>{#each n.children as c (c.name)}{@render branch(c)}{/each}</ul>{/if}
	</li>
{/snippet}

{#snippet even()}<i id="which">even</i>{/snippet}
{#snippet odd()}<b id="which">odd</b>{/snippet}

<section id="runes">
	<button id="count" onclick={() => count++}>count {count}</button>
	<p id="derived">{doubled} {parity}</p>
	<p id="user">{userName} [{langs.join(',')}] {snapshot}</p>
	<button id="learn" onclick={() => user.langs.push('ts')}>learn</button>
	<button id="rename-user" onclick={() => (user = { name: 'Alan', langs: ['c'] })}>rename user</button>
	<p id="raw">{raw.join(',')}</p>
	<button id="raw-push" onclick={() => raw.push(raw.length + 1)}>raw push</button>
	<button id="raw-assign" onclick={() => (raw = [...raw])}>raw assign</button>
	<p id="override">{override}</p>
	<button id="override-set" onclick={() => (override = 42)}>override</button>
	<p id="peek">{peek}</p>
	<button id="label" onclick={() => (label = label === 'a' ? 'b' : 'a')}>label</button>
	<p id="effects">{effectLog} / {preLog} / aborted {aborted} / root {rootRuns}</p>
	<p id="tracking">{trackingInScript} {$effect.tracking()}</p>
	<p id="eager">{$state.eager(count)}</p>
</section>

<section id="timing">
	<button
		id="flush"
		onclick={() => {
			flushSync(() => count++);
			flushed = document.getElementById('count').textContent;
		}}>flushSync</button
	>
	<button
		id="ticked"
		onclick={async () => {
			count++;
			await tick();
			ticked = document.getElementById('count').textContent;
		}}>tick</button
	>
	<p id="timing-out">{flushed} / {ticked}</p>
</section>

<section id="control">
	{#if count > 5}
		<p id="size">big</p>
	{:else if count > 0}
		<p id="size">small</p>
	{:else}
		<p id="size">none</p>
	{/if}

	<ul id="todos">
		{#each todos.items as todo, i (todo.id)}
			{@const n = i + 1}
			<li class={{ done: todo.done }}>
				<input type="checkbox" class="todo-done" bind:checked={todo.done} />
				<input class="todo-text" bind:value={todo.text} />
				<span class="todo-label">{n}. {todo.text} ({todo.edits})</span>
			</li>
		{:else}
			<li id="no-todos">nothing to do</li>
		{/each}
	</ul>
	<p id="remaining">{todos.remaining} remaining</p>
	<input id="new-todo" bind:value={newTodo} />
	<button
		id="add-todo"
		onclick={() => {
			todos.add(newTodo);
			newTodo = '';
		}}>add</button
	>
	<button id="clear-done" onclick={() => todos.clearDone()}>clear done</button>
	<button id="rename-todo" onclick={() => todos.items[0]?.rename('renamed')}>rename todo</button>

	<p id="stars">{#each { length: stars }, i}<span class="star" data-i={i}>*</span>{/each}</p>
	<button id="more-stars" onclick={() => stars++}>more stars</button>
	<table id="grid">
		<tbody>
			{#each grid as row, r}
				<tr>{#each row as cell, c}<td>{r},{c}={cell}</td>{/each}</tr>
			{/each}
		</tbody>
	</table>
	<button id="grid-edit" onclick={() => (grid[1][0] = 9)}>grid edit</button>

	{#key keyVersion}<span id="keyed">v{keyVersion}</span>{/key}
	<button id="rekey" onclick={() => keyVersion++}>rekey</button>

	{#await promise}
		<p id="await">loading</p>
	{:then value}
		<p id="await">then {value}</p>
	{:catch error}
		<p id="await">catch {error.message}</p>
	{/await}
	<button id="await-pending" onclick={() => (promise = new Promise((r) => (resolvePending = r)))}>pending</button>
	<button id="await-resolve" onclick={() => resolvePending('second')}>resolve</button>
	<button id="await-reject" onclick={() => (promise = Promise.reject(new Error('bad')))}>reject</button>
	{#await failing then value}<p>{value}</p>{:catch error}<p id="await-fail">caught {error.message}</p>{/await}
	{#await 42 then value}<p id="await-sync">sync {value}</p>{/await}
</section>

<section id="snippets">
	<p id="greets">{@render greet('snippet')} {@render greet(userName, '?')}</p>
	<ul id="snippet-tree">{@render branch(tree)}</ul>
	<p id="swap">{@render (count % 2 ? odd : even)()}</p>
	<p id="raw-snippet">{@render rawBadge(userName)}</p>
	<Card title="card" --accent="tomato">
		{#snippet header(title)}<h3 id="card-header">header for {title}</h3>{/snippet}
		<p class="card-body" id="card-body">body {count}</p>
		{#snippet footer(len)}<small id="card-footer">title has {len} chars</small>{/snippet}
	</Card>
	<Card />
</section>

<section id="attrs">
	<div id="classes" class={['base', count % 2 && 'odd', { big: count > 3 }]} class:flagged={flag}>classes</div>
	<button id="flag" onclick={() => (flag = !flag)}>flag</button>
	<div
		id="styles"
		style="border: 1px solid"
		style:color
		style:--size="{count}px"
		style:font-weight|important={count ? 'bold' : 'normal'}
	>
		styles
	</div>
	<button id="color" onclick={() => (color = color === 'red' ? 'blue' : 'red')}>color</button>
	<div id="spread" {...attrs}>spread</div>
	<button id="maybe-disabled" disabled={count > 3}>maybe disabled</button>
	<svelte:element this={tag} id="dynamic-el" class="dyn">{tag}</svelte:element>
	<button id="tag" onclick={() => (tag = tag === 'div' ? 'section' : 'div')}>tag</button>
	<svg id="svg" width="100" height="100" viewBox="0 0 100 100">
		<circle id="circle" cx="50" cy="50" r={10 + count} />
		<Shape size={count} />
	</svg>
	<math id="math"><mi>x</mi><mo>+</mo><mn>{count}</mn></math>
	<div id="html">{@html `<b>bold ${count}</b>`}</div>
</section>

<section id="bindings">
	<input id="text" bind:value={text} />
	<input id="upper" bind:value={() => text.toUpperCase(), (v) => (text = v.toLowerCase())} />
	<p id="text-out">{text}</p>
	<textarea id="area" bind:value={area}></textarea>
	<p id="area-out">{area.split('\n').length} lines</p>
	<input id="num" type="number" bind:value={num} />
	<input id="range" type="range" min="0" max="10" bind:value={num} />
	<p id="num-out">{typeof num} {num}</p>
	<input id="check" type="checkbox" bind:checked bind:indeterminate />
	<p id="check-out">{checked} {indeterminate}</p>
	{#each ['a', 'b', 'c'] as flavour}
		<label><input type="checkbox" class="flavour" value={flavour} bind:group={flavours} />{flavour}</label>
	{/each}
	{#each ['s', 'm', 'l'] as s}
		<label><input type="radio" class="size" name="size" value={s} bind:group={size} />{s}</label>
	{/each}
	<p id="group-out">{flavours.join(',')} / {size}</p>
	<select id="select" bind:value={selected}>
		{#each options as option (option.id)}<option value={option}>{option.label}</option>{/each}
	</select>
	<select id="multi" multiple bind:value={multi}>
		<option>x</option>
		<option>y</option>
		<option>z</option>
	</select>
	<p id="select-out">{selected.label} / {multi.join(',')}</p>
	<details id="details" bind:open><summary>more</summary>hidden text</details>
	<p id="open-out">open {open}</p>
	<div id="editable" contenteditable="true" bind:innerHTML={editable}></div>
	<p id="editable-out">{editable}</p>
	<p id="size-probe" bind:clientWidth={width}>width {width ?? '?'}</p>
	<audio id="audio" bind:volume bind:muted></audio>
	<button id="audio-edit" onclick={() => ((volume = 0.5), (muted = true))}>audio</button>
	<p id="audio-out">{volume} {muted}</p>
	<canvas id="canvas" bind:this={canvas}></canvas>
	<p id="this-out">{canvas?.tagName ?? 'none'}</p>
	<Counter
		bind:this={counterRef}
		bind:value={bound}
		step={2}
		label="bound"
		data-role="counter"
		{@attach counterAttach}
		onchange={(v) => (lastChange = v)}
	/>
	<p id="bound-out">{bound} last {lastChange}</p>
	<button id="counter-reset" onclick={() => counterRef.reset()}>reset counter</button>
	<button id="bound-set" onclick={() => (bound = 100)}>set bound</button>
</section>

<section id="events">
	<button id="delegated" onclick={() => clicks++}>clicks {clicks}</button>
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div id="phases" onclickcapture={() => phases.push('capture')} onclick={() => phases.push('bubble')}>
		<button id="phase-target" onclick={() => phases.push('target')}>phases</button>
	</div>
	<p id="phases-out">{phases.join(',')}</p>
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div id="outer" onclick={() => outerClicks++}>
		<button
			id="inner"
			onclick={(e) => {
				e.stopPropagation();
				innerClicks++;
			}}>inner</button
		>
	</div>
	<p id="propagation-out">{innerClicks} {outerClicks}</p>
	<input id="focus" onfocus={() => (focused = true)} onblur={() => (focused = false)} />
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div id="hover" onmouseenter={() => (hovered = true)} onmouseleave={() => (hovered = false)}>hover</div>
	<p id="focus-out">{focused} {hovered}</p>
	<button id="swap-handler" onclick={handler}>swap handler</button>
	<button id="spread-handler" {...{ onclick: () => spreadClicks++ }}>spread {spreadClicks}</button>
	<p id="handler-out">{handled}</p>
	<p id="window-out">
		key {lastKey} / width {winWidth} / online {online} / visibility {visibility} / pings {pings}
	</p>
	<p id="body-out">{bodyClicks}</p>
</section>

<section id="actions">
	<span id="action" use:tooltip={`count ${count}`}>action</span>
	<span id="attach" {@attach counted} {@attach (node) => void (node.dataset.inline = 'yes')}>attach</span>
	<span id="from-action" {@attach fromAction(tooltip, () => `fa ${count}`)}>from action</span>
	<span id="attach-key" {...attachProps}>attachment key</span>
</section>

<section id="components">
	<Current text={userName} />
	<button id="swap-component" onclick={() => (Current = Current === Fancy ? Plain : Fancy)}>swap component</button>
	<ul id="tree"><Tree node={tree} /></ul>
	<Themed />
	<button id="theme" onclick={() => (theme.color = theme.color === 'teal' ? 'navy' : 'teal')}>theme</button>
	{#if showLifecycle}<Lifecycle log={(m) => lifecycleLog.push(m)} />{/if}
	<button id="toggle-lifecycle" onclick={() => (showLifecycle = !showLifecycle)}>toggle lifecycle</button>
	<p id="lifecycle-log">{lifecycleLog.join(',')}</p>
	<svelte:boundary onerror={(e) => (boundaryError = e.message)}>
		<Bomb {armed} />
		{#snippet failed(error, reset)}
			<p id="boundary-failed">failed: {error.message}</p>
			<button
				id="boundary-reset"
				onclick={() => {
					armed = false;
					reset();
				}}>reset boundary</button
			>
		{/snippet}
	</svelte:boundary>
	<button id="arm" onclick={() => (armed = true)}>arm</button>
	<p id="boundary-out">{boundaryError}</p>
	<p id="shared-out">{shared.clicks} / {counter.count} {counter.double}</p>
	<button
		id="shared-inc"
		onclick={() => {
			shared.clicks++;
			counter.increment();
		}}>shared</button
	>
</section>

<section id="libs">
	<p id="map-out">
		{#each scores as [name, score] (name)}<span class="score">{name}={score}</span>{/each} size {scores.size}
	</p>
	<button id="map-add" onclick={() => scores.set(`p${scores.size}`, scores.size)}>map add</button>
	<button id="map-bump" onclick={() => scores.set('ada', scores.get('ada') + 1)}>map bump</button>
	<p id="set-out">{#each tags as tag (tag)}<span class="tag">{tag}</span>{/each} has svelte {tags.has('svelte')}</p>
	<button id="set-toggle" onclick={() => (tags.has('svelte') ? tags.delete('svelte') : tags.add('svelte'))}>set toggle</button>
	<p id="date-out">{date.getFullYear()}-{date.getMonth() + 1}-{date.getDate()}</p>
	<button id="date-next" onclick={() => date.setDate(date.getDate() + 1)}>next day</button>
	<p id="url-out">{url.href} / {params.toString()}</p>
	<button
		id="url-edit"
		onclick={() => {
			url.searchParams.set('q', 'svelte');
			params.append('b', '2');
		}}>url</button
	>
	<p id="media-out">wide {wide.current} / reduced {prefersReducedMotion.current} / inner {innerWidth.current}</p>
	<p id="ticker-out">ticks {ticker.value} / listeners {ticker.listeners}</p>
	<button id="tick" onclick={() => ticker.tick()}>tick</button>
	<p id="store-out">{$countStore} {$sum} {$ro} {$started} {$profile.name} {fromCount.current} {$targetStore} {gotten}</p>
	<button id="store-inc" onclick={() => countStore.update((n) => n + 1)}>store inc</button>
	<button id="store-assign" onclick={() => ($countStore = 10)}>store assign</button>
	<button id="store-mutate" onclick={() => ($profile.name = 'Grace')}>store mutate</button>
	<button id="store-from" onclick={() => (fromCount.current = 20)}>store from</button>
	<button id="store-to" onclick={() => ($targetStore = 7)}>store to</button>
	<button id="store-get" onclick={() => (gotten = String(get(countStore)))}>store get</button>
	<p id="motion-out">{instant.current} {tween.current} {spring.current}</p>
	<button
		id="motion"
		onclick={() => {
			instant.set(5);
			tween.target = 10;
			spring.set(3, { instant: true });
		}}>motion</button
	>
</section>

<style>
	section {
		margin-block: 4px;
	}
	.dyn {
		font-style: italic;
	}
	:global(.keyed-attach) {
		text-decoration: underline;
	}
</style>
