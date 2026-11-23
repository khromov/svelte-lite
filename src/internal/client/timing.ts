import type { Raf } from './types.ts';
import { noop } from '../shared/utils.ts';
import { BROWSER } from 'esm-env';

const now = BROWSER ? () => performance.now() : () => Date.now();

export const raf: Raf = {
	// don't access requestAnimationFrame eagerly outside method
	// this allows basic testing of user code without JSDOM
	// bundler will eval and remove ternary when the user's app is built
	tick: (_: any) => (BROWSER ? requestAnimationFrame : noop)(_),
	now: () => now(),
	tasks: new Set()
};
