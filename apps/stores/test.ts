import type { AppTest } from '../../check.ts';

export default {
	before(doc) {
		return { inc: doc.querySelector('#inc'), li: doc.querySelector('#items li') };
	},
	async after(doc, refs, t) {
		const $ = (s: string) => doc.querySelector(s);
		t.same($('#inc'), refs.inc, '#inc reused');
		t.same($('#items li'), refs.li, 'store-driven {#each} row reused');
		t.eq($('#mirror')?.textContent, 'mirror 0', '$effect.pre ran on hydrate');

		await t.click($('#inc'));
		t.eq($('#inc')?.textContent, 'count 1', 'store update renders');
		t.eq($('#doubled')?.textContent, 'doubled 2', 'derived store updates');
		t.eq($('#mirror')?.textContent, 'mirror 10', '$effect.pre write during traversal is applied');

		await t.click($('#inc'));
		t.eq($('#mirror')?.textContent, 'mirror 20', 'second update');

		await t.click($('#rename'));
		t.eq($('#items li')?.textContent, 'a!', 'in-place mutation of a store item re-renders ({#each $store}: mutable item sources)');
		t.same($('#items li'), refs.li, 'row kept');
		await t.click($('#rename'));
		t.eq($('#items li')?.textContent, 'a!!', 'again');
	}
} satisfies AppTest;
