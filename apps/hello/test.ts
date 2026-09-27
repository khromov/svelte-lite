import type { AppTest } from '../../check.ts';

export default {
	before(doc) {
		return { h1: doc.querySelector('#app h1') };
	},
	async after(doc, refs, t) {
		t.same(doc.querySelector('#app h1'), refs.h1, 'SSR <h1> reused by hydrate()');
		t.eq(doc.querySelector('#app h1')?.textContent, 'Hello world!', 'h1 text');
	},
	// hydrate() mismatch recovery (root closing marker removed): warn, clear, client render
	mismatch: {
		corrupt: (html) => {
			const out = html.replace(/<!--\]--><\/div>/, '</div>');
			if (out === html) throw new Error('mismatch scenario: root close marker not found');
			return out;
		},
		async after(doc, t) {
			t.eq(doc.querySelectorAll('#app h1').length, 1, 'exactly one h1 after recovery');
			t.eq(doc.querySelector('#app h1')?.textContent, 'Hello world!', 'client render after recovery');
		}
	}
} satisfies AppTest;
