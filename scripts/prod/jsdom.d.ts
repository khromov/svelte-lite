// jsdom comes without types. This is what worker.ts uses of it
declare module 'jsdom' {
	import type { Context } from 'node:vm';

	export class VirtualConsole {}

	export class JSDOM {
		constructor(html?: string, options?: Record<string, unknown>);
		readonly window: Window & typeof globalThis;
		getInternalVMContext(): Context;
	}
}
