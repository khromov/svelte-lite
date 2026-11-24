// The compiler is Svelte's own, unmodified: it never reaches the browser. svelte-lite
// only narrows what it accepts, so that an unsupported feature fails when compiling
// instead of at some later point in the browser.
import { compile as svelte_compile } from '../../vendor/svelte/packages/svelte/src/compiler/index.js';
import { check, describe } from '../../check/index.ts';
import { unsupported } from '../unsupported.ts';

export * from '../../vendor/svelte/packages/svelte/src/compiler/index.js';

export const compile: typeof svelte_compile = (source, options) => {
	// these are missing from the client runtime. The server runtime is Svelte's, and has them
	if ((options?.generate ?? 'client') === 'client') {
		if (options?.experimental?.async) unsupported('`experimental.async` in the browser');
		if (options?.experimental?.customRenderer) unsupported('custom renderers');
		if (options?.compatibility?.componentApi === 4) {
			unsupported('`compatibility.componentApi: 4`, which is deprecated: use `mount` instead');
		}
	}

	// every component is a runes component, also one that uses no runes
	const result = svelte_compile(source, { ...options, runes: options?.runes ?? true });

	// Svelte's compiler has its say first: it rejects what legacy mode and `experimental.async`
	// have in a runes component without the option, with its own errors. The check rejects
	// the rest, for the server as well, so that a component fails the same way everywhere
	const filename = options?.filename;
	const custom_element = options?.customElement;
	const [finding] = check(source, {
		filename,
		// the client already failed above if it was on
		async: !!options?.experimental?.async,
		customElement:
			typeof custom_element === 'function'
				? custom_element({ filename: filename ?? '(unknown)' })
				: custom_element
	});
	if (finding) unsupported(describe(finding, filename));

	// what the check cannot see, such as `runes: false` among the options
	if (!result.metadata.runes) {
		unsupported(`legacy mode: ${options?.filename ?? 'a component'} has to use runes`);
	}

	return result;
};
