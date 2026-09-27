import type { AppTest } from '../../check.ts';

export default {
	before(doc) {
		return { count: doc.querySelector('#count'), ok: doc.querySelector('#ok'), last: doc.querySelector('#last') };
	},
	async after(doc, refs, t) {
		const $ = (s: string) => doc.querySelector(s);
		t.same($('#count'), refs.count, '#count reused');
		t.same($('#ok'), refs.ok, 'content inside <svelte:boundary> reused');
		t.same($('#last'), refs.last, '#last reused');

		await t.click($('#count'));
		t.eq($('#ok')?.textContent, 'fine 1', 'state inside the boundary updates');

		await t.click($('#break'));
		t.eq($('#failed')?.textContent, 'failed: boom', 'failed snippet shown after a render error');
		t.ok(!$('#ok'), 'broken content removed');
		t.eq($('#last')?.textContent, 'last error: boom', 'onerror called');

		await t.click($('#retry'));
		t.ok(!$('#failed'), 'reset() removes the failed snippet');
		t.eq($('#ok')?.textContent, 'fine 1', 'content re-rendered after reset()');
	}
} satisfies AppTest;
