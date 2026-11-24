import type { Component, ComponentType, MountOptions, SvelteComponent } from '../../index.ts';
import type { ComponentContext, Effect, EffectNodes, TemplateNode } from './types.ts';
import { DEV } from 'esm-env';
import { HYDRATION_END, HYDRATION_ERROR, HYDRATION_START } from '../../constants.ts';
import { COMMENT_NODE, EFFECT_TRANSPARENT, TEXT_CACHE } from './constants.ts';
import { component_context, mark_as_component, pop, push } from './context.ts';
import {
	hydrate_next,
	hydrate_node,
	hydrating,
	set_hydrate_node,
	set_hydrating
} from './dom/hydration.ts';
import { create_text, get_first_child, get_next_sibling } from './dom/operations.ts';
import { assign_nodes } from './dom/template.ts';
import * as e from './errors.ts';
import { branch, component_root, destroy_effect, pause_effect } from './reactivity/effects.ts';
import { active_effect } from './runtime.ts';
import * as w from './warnings.ts';
import { unsupported } from '../../unsupported.ts';

/**
 * This is normally true — block effects should run their intro transitions —
 * but is false during hydration (unless `options.intro` is `true`) and
 * when creating the children of a `<svelte:element>` that just changed tag
 */
export let should_intro = true;

export function set_should_intro(value: boolean): void {
	should_intro = value;
}

export function set_text(text: Text, value: any): void {
	// For objects, we apply string coercion (which might make things like $state array references in the template reactive) before diffing
	var str = value == null ? '' : typeof value === 'object' ? `${value}` : value;

	if (str !== ((text as any)[TEXT_CACHE] ??= text.nodeValue)) {
		(text as any)[TEXT_CACHE] = str;
		text.nodeValue = `${str}`;
	}
}

/** The options of `mount` and `hydrate` as `_mount` reads them */
type Options = MountOptions<Record<string, any>>;

/**
 * Svelte's `mount` and `hydrate` take an `events` option, with handlers for the events that
 * a component dispatches. svelte-lite has no such events, and nothing reads the option, so
 * the handlers would never be called and nothing would say why.
 */
function reject_events(options: object): void {
	if ((options as { events?: unknown }).events != null) {
		unsupported(
			'the `events` option of `mount` and `hydrate`: pass the handlers as callback props instead'
		);
	}
}

/**
 * Mounts a component to the given target and returns the exports and potentially the props (if compiled with `accessors: true`) of the component.
 * Transitions will play during the initial render unless the `intro` option is set to `false`.
 */
export function mount<
	Props extends Record<string, any>,
	Exports extends Record<string, any>,
	Renderer = undefined
>(
	component: ComponentType<SvelteComponent<Props>> | Component<Props, Exports, any>,
	options: MountOptions<Props, Renderer>
): Exports {
	if (DEV) reject_events(options);

	return _mount(component, options as Options);
}

/**
 * Hydrates a component on the given target and returns the exports and potentially the props (if compiled with `accessors: true`) of the component
 */
// `Renderer` is unused, but the type parameters need to match `mount`'s,
// otherwise a `hydrate | mount` union isn't callable
export function hydrate<
	Props extends Record<string, any>,
	Exports extends Record<string, any>,
	Renderer = undefined
>(
	component: ComponentType<SvelteComponent<Props>> | Component<Props, Exports, any>,
	options: {} extends Props
		? {
				target: Document | Element | ShadowRoot;
				props?: Props;
				context?: Map<any, any>;
				intro?: boolean;
				recover?: boolean;
				transformError?: (error: unknown) => unknown;
			}
		: {
				target: Document | Element | ShadowRoot;
				props: Props;
				context?: Map<any, any>;
				intro?: boolean;
				recover?: boolean;
				transformError?: (error: unknown) => unknown;
			}
): Exports {
	// before anything is hydrated: an error from inside would count as a failed hydration
	if (DEV) reject_events(options);

	options.intro = options.intro ?? false;
	const target = options.target;
	const was_hydrating = hydrating;
	const previous_hydrate_node = hydrate_node;

	try {
		var anchor = get_first_child(target);

		while (anchor && (anchor.nodeType !== COMMENT_NODE || anchor.nodeValue !== HYDRATION_START)) {
			anchor = get_next_sibling(anchor);
		}

		if (!anchor) {
			throw HYDRATION_ERROR;
		}

		set_hydrating(true);
		set_hydrate_node(anchor);
		hydrate_next();

		const instance = _mount<Exports>(component, { ...options, anchor } as Options);

		set_hydrating(false);

		return instance;
	} catch (error) {
		// re-throw Svelte errors - they are certainly not related to hydration
		if (
			error instanceof Error &&
			error.message.split('\n').some((line) => line.startsWith('https://svelte.dev/e/'))
		) {
			throw error;
		}
		if (error !== HYDRATION_ERROR) {
			// eslint-disable-next-line no-console
			console.warn('Failed to hydrate: ', error);
		}

		if (options.recover === false) {
			e.hydration_failed();
		}

		target.textContent = '';

		set_hydrating(false);
		return _mount<Exports>(component, options as Options);
	} finally {
		set_hydrating(was_hydrating);
		set_hydrate_node(previous_hydrate_node);
	}
}

function _mount<Exports extends Record<string, any>>(
	Component: ComponentType<SvelteComponent<any>> | Component<any, any, any>,
	{ target, anchor, props = {}, context, intro = true, transformError }: Options
): Exports {
	// will be defined because the render effect runs synchronously
	var component = undefined as unknown as Exports;

	var root = component_root(() => {
		var anchor_node = anchor ?? target.appendChild(create_text());

		if (transformError) {
			// a `<svelte:boundary>` takes this from the effect it is created in (see `boundary`)
			(active_effect as Effect).b = { transform_error: transformError };
		}

		var effect = branch(() => {
			push({});
			var ctx = component_context as ComponentContext;
			if (context) ctx.c = context;

			if (hydrating) {
				assign_nodes(anchor_node as TemplateNode, null);
			}

			should_intro = intro;
			// the public typings are not what the actual function looks like
			component = (Component as any)(anchor_node, props) || mark_as_component();
			should_intro = true;

			if (hydrating) {
				(active_effect as Effect & { nodes: EffectNodes }).nodes.end = hydrate_node;

				if (
					hydrate_node?.nodeType !== COMMENT_NODE ||
					hydrate_node.nodeValue !== HYDRATION_END
				) {
					w.hydration_mismatch();
					throw HYDRATION_ERROR;
				}
			}

			pop();
		});

		// the transitions of the elements at the top of the component play when it is unmounted
		effect.f |= EFFECT_TRANSPARENT;

		return () => {
			if (anchor_node !== anchor) {
				anchor_node.parentNode?.removeChild(anchor_node);
			}
		};
	});

	mounted_components.set(component, root);
	return component;
}

/**
 * References of the components that were mounted or hydrated.
 * Uses a `WeakMap` to avoid memory leaks.
 */
let mounted_components = new WeakMap<Record<string, any>, Effect>();

/**
 * Unmounts a component that was previously mounted using `mount` or `hydrate`.
 *
 * Since 5.13.0, if `options.outro` is `true`, [transitions](https://svelte.dev/docs/svelte/transition) will play before the component is removed from the DOM.
 *
 * Returns a `Promise` that resolves after transitions have completed if `options.outro` is true, or immediately otherwise (prior to 5.13.0, returns `void`).
 *
 * ```js
 * import { mount, unmount } from 'svelte';
 * import App from './App.svelte';
 *
 * const app = mount(App, { target: document.body });
 *
 * // later...
 * unmount(app, { outro: true });
 * ```
 */
export function unmount(
	component: Record<string, any>,
	options?: { outro?: boolean }
): Promise<void> {
	const root = mounted_components.get(component);

	if (root) {
		mounted_components.delete(component);

		return new Promise((fulfil) => {
			if (options?.outro) {
				pause_effect(root, () => {
					destroy_effect(root);
					fulfil();
				});
			} else {
				destroy_effect(root);
				fulfil();
			}
		});
	}

	if (DEV) {
		w.lifecycle_double_unmount();
	}

	return Promise.resolve();
}
