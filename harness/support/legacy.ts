/**
 * Test support, not part of svelte-lite: what three drivers of Svelte's suite get when they
 * import `svelte/legacy`, which svelte-lite removed. They use its `createClassComponent` only
 * to mount the component of each sample (tests/runtime-browser/driver.js,
 * tests/hydration/test.ts, tests/runtime-legacy/shared.ts), for tests that are about anything
 * but that function. `harness/resolve.ts` sends those files here, and nothing else: a sample
 * that imports `svelte/legacy` itself fails to load.
 *
 * It is built on the public API, the way upstream's driver of the runes suite mounts a
 * component: props in a `$state` proxy, `mount` or `hydrate`, `flushSync`, `unmount`. The
 * object it returns has what those drivers and their tests use of a Svelte 4 component: the
 * component's exports as properties, `$set` and `$destroy`. There is no `$on`.
 */
import { flushSync, hydrate, mount, unmount } from 'svelte';
// @ts-expect-error: the contract with the compiler has no types
import { proxy } from 'svelte/internal/client';

interface Options {
	component: any;
	target: Document | Element | ShadowRoot;
	anchor?: Element;
	props?: Record<string, any>;
	context?: Map<any, any>;
	hydrate?: boolean;
	intro?: boolean;
	recover?: boolean;
	sync?: boolean;
	transformError?: (error: unknown) => unknown;
}

export function createClassComponent(options: Options): Record<string, any> {
	const props: Record<string, any> = proxy({ ...options.props });

	const mount_options = {
		target: options.target,
		anchor: options.anchor,
		props,
		context: options.context,
		// as for a Svelte 4 component, transitions do not play on the first render by default
		intro: options.intro ?? false,
		recover: options.recover,
		transformError: options.transformError
	};

	const instance: Record<string, any> = options.hydrate
		? hydrate(options.component, mount_options)
		: mount(options.component, mount_options);

	if (options.sync !== false) flushSync();

	const component: Record<string, any> = {
		$set(next: Record<string, any>) {
			Object.assign(props, next);
		},
		$destroy() {
			unmount(instance);
		}
	};

	for (const key of Object.keys(instance)) {
		// in dev, a component has these to say that they no longer exist
		if (key === '$set' || key === '$destroy' || key === '$on') continue;

		Object.defineProperty(component, key, {
			get: () => instance[key],
			set: (value) => (instance[key] = value),
			enumerable: true
		});
	}

	return component;
}
