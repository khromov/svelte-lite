// A flag is set by a module of its own, which the compiler makes a component import when it
// uses the feature. With nothing importing that module, a bundler can tell that the flag
// stays `false` and drops the code behind it.
//
// Legacy mode and `experimental.async` in the browser are left out of svelte-lite. Their flags
// are here all the same: the modules borrowed from Svelte read them, and so does Svelte's
// server runtime, which does have async.

/** True if experimental.async=true */
export let async_mode_flag = false;
/** True if we're not certain that we only have Svelte 5 code in the compilation */
export let legacy_mode_flag = false;
/** True if $inspect.trace is used */
export let tracing_mode_flag = false;
/**
 * True if custom renderers are used, which svelte-lite leaves out: nothing sets this.
 * The modules borrowed from Svelte still read it
 */
export const custom_renderers_flag: boolean = false;

export function enable_async_mode_flag() {
	async_mode_flag = true;
}

/** ONLY USE THIS DURING TESTING */
export function disable_async_mode_flag() {
	async_mode_flag = false;
}

export function enable_legacy_mode_flag() {
	legacy_mode_flag = true;
}

export function enable_tracing_mode_flag() {
	tracing_mode_flag = true;
}
