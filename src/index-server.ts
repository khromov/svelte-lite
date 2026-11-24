// @reused from Svelte: the server runtime never reaches the browser, so svelte-lite does not replace it.
// The deprecated functions that svelte-lite leaves out are not passed on, so that a component
// that imports one fails on the server as it does in the browser.
export {
	onDestroy,
	onMount,
	flushSync,
	untrack,
	mount,
	hydrate,
	unmount,
	fork,
	tick,
	settled,
	getAbortSignal,
	createContext,
	getAllContexts,
	getContext,
	hasContext,
	setContext,
	hydratable,
	createRawSnippet
} from '../vendor/svelte/packages/svelte/src/index-server.js';
