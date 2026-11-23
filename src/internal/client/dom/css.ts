import { DEV } from 'esm-env';
import { register_style } from '../dev/css.ts';
import { effect } from '../reactivity/effects.ts';
import { active_effect } from '../runtime.ts';
import { create_element } from './operations.ts';

export function append_styles(anchor: Node, css: { hash: string; code: string }): void {
	// Use an effect to ensure `anchor` is in the DOM, otherwise getRootNode() will yield wrong results
	effect(() => {
		// Bit of a hack: branches.js/each.js use offscreen fragments with temporary text nodes that will
		// never be connected to the real dom. Therefore walk up to the branch that has created the component
		// whose styles we want to append, and check its node instead. It will be connected by the time we get here.
		anchor = active_effect?.parent?.nodes?.start ?? anchor;
		var root = anchor.getRootNode() as ShadowRoot | Document;

		var target = (root as ShadowRoot).host
			? (root as ShadowRoot)
			: (root as Document).head ?? (root.ownerDocument as Document).head;

		// Always querying the DOM is roughly the same perf as additionally checking for presence in a map first assuming
		// that you'll get cache hits half of the time, so we just always query the dom for simplicity and code savings.
		if (!target.querySelector('#' + css.hash)) {
			const style = create_element('style');
			style.id = css.hash;
			style.textContent = css.code;

			target.appendChild(style);

			if (DEV) {
				register_style(css.hash, style);
			}
		}
	});
}
