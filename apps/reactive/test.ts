import type { AppTest } from '../../check.ts';

const texts = (doc: Document) => [...doc.querySelectorAll('#list li .text')].map((n) => n.textContent);

export default {
	before(doc) {
		const $ = (s: string) => doc.querySelector(s);
		return {
			inc: $('#inc'),
			doubled: $('#doubled'),
			box: $('#box'),
			input: $('#name'),
			greeting: $('#greeting'),
			list: $('#list'),
			li: [...doc.querySelectorAll('#list li')],
			childCount: $('#child-count'),
			badges: [...doc.querySelectorAll('.badge')]
		};
	},
	async after(doc, refs, t) {
		const $ = (s: string) => doc.querySelector(s);

		// (b) hydration reused the server-rendered nodes
		for (const key of ['inc', 'doubled', 'box', 'input', 'greeting', 'list', 'childCount'] as const) {
			t.same($(`#${key === 'childCount' ? 'child-count' : key === 'input' ? 'name' : key}`), refs[key], `#${key} reused`);
		}
		const li = [...doc.querySelectorAll('#list li')];
		t.eq(li.length, 2, 'two SSR list items');
		li.forEach((n, i) => t.same(n, refs.li[i], `li[${i}] reused`));
		[...doc.querySelectorAll('.badge')].forEach((n, i) => t.same(n, refs.badges[i], `snippet badge[${i}] reused`));
		t.eq(refs.badges.length, 2, 'two badges (snippet rendered in app and as child children)');
		t.eq($('#child .badge')?.textContent, 'from-parent', 'children snippet rendered inside child');

		// (c) interactions: $state counter + delegated onclick, $derived, {#if}, class:, style:, child prop
		await t.click($('#inc'));
		t.eq($('#inc')?.textContent, 'count: 1', 'click increments');
		t.eq($('#doubled')?.textContent, 'doubled: 2', '$derived updates');
		t.eq($('#parity')?.textContent, 'odd', '{#if}/{:else} switches');
		t.ok($('#box')?.classList.contains('active'), 'class: directive applied');
		t.eq($('#child-count')?.textContent, 'child: 1', 'child $props update');
		t.same($('#inc'), refs.inc, 'button node still the SSR node');

		await t.click($('#inc'));
		t.eq($('#parity')?.textContent, 'even', '{#if} switches back');

		await t.click($('#color'));
		t.eq(($('#box') as HTMLElement).style.color, 'blue', 'style: directive follows deep state');
		await t.click($('#color'));
		t.eq(($('#box') as HTMLElement).style.color, 'red', 'style: directive toggles back');

		// bind:value
		await t.type($('#name'), 'Svelte');
		t.eq($('#greeting')?.textContent, 'Hello Svelte!', 'bind:value updates state');

		// keyed each + deep state (push, splice, property mutation)
		await t.click($('#add'));
		t.eq(JSON.stringify(texts(doc)), JSON.stringify(['one', 'two', 'item 3']), 'items.push() renders a new row');
		const afterAdd = [...doc.querySelectorAll('#list li')];
		t.same(afterAdd[0], refs.li[0], 'keyed row 0 kept');
		t.same(afterAdd[1], refs.li[1], 'keyed row 1 kept');

		await t.click(afterAdd[0].querySelector('.remove'));
		t.eq(JSON.stringify(texts(doc)), JSON.stringify(['two', 'item 3']), 'splice removes the row');
		t.same(doc.querySelector('#list li'), refs.li[1], 'remaining keyed row is the same node');

		await t.click(doc.querySelector('#list li .toggle'));
		t.ok(doc.querySelector('#list li')?.classList.contains('done'), 'item.done mutation re-renders (deep state)');
		await t.click(doc.querySelector('#list li .toggle'));
		t.ok(!doc.querySelector('#list li')?.classList.contains('done'), 'toggle back');

		// assigning a fresh array to $state must still be deeply reactive
		await t.click($('#reset'));
		t.eq(JSON.stringify(texts(doc)), JSON.stringify(['fresh']), 'reassigned array rendered');
		await t.click(doc.querySelector('#list li .toggle'));
		t.ok(doc.querySelector('#list li')?.classList.contains('done'), 'reassigned array is deeply reactive');
		await t.click($('#add'));
		t.eq(JSON.stringify(texts(doc)), JSON.stringify(['fresh', 'item 4']), 'push on reassigned array');
	},
	// hydrate() mismatch recovery: remove the root's closing `<!--]-->` marker; _mount's end
	// check must warn (hydration_mismatch), hydrate() must clear the target and fall back to a
	// client render, and the app must still work
	mismatch: {
		corrupt: (html) => {
			const out = html.replace(/<!--\]--><\/div>/, '</div>');
			if (out === html) throw new Error('mismatch scenario: root close marker not found');
			return out;
		},
		async after(doc, t) {
			const $ = (s: string) => doc.querySelector(s);
			t.eq(doc.querySelectorAll('#inc').length, 1, 'one app instance after recovery (target cleared)');
			t.eq($('#doubled')?.textContent, 'doubled: 0', 'client render restored the missing element');
			await t.click($('#inc'));
			t.eq($('#inc')?.textContent, 'count: 1', 'recovered app is interactive (delegated click)');
			t.eq($('#doubled')?.textContent, 'doubled: 2', '$derived after recovery');
			await t.click($('#add'));
			t.eq(doc.querySelectorAll('#list li').length, 3, 'each block after recovery');
		}
	}
} satisfies AppTest;
