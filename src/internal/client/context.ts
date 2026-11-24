import type { ComponentContext, DevStackEntry, Effect } from './types.ts';
import { DEV } from 'esm-env';
import { active_effect } from './runtime.ts';
import { create_user_effect, has_effects } from './reactivity/effects.ts';
import { FILENAME } from '../../constants.ts';
import { COMPONENT_SYMBOL } from './constants.ts';
import { define_property } from '../shared/utils.ts';
import { create_context, get_or_init_context_map } from '../shared/context.ts';

export let component_context: ComponentContext | null = null;

export function set_component_context(context: ComponentContext | null): void {
	component_context = context;
}

export let dev_stack: DevStackEntry | null = null;

export function set_dev_stack(stack: DevStackEntry | null): void {
	dev_stack = stack;
}

/**
 * Execute a callback with a new dev stack entry
 * @param callback - Function to execute
 * @param type - Type of block/component
 * @param component - Component function
 * @param line - Line number
 * @param column - Column number
 * @param additional - Any additional properties to add to the dev stack entry
 */
export function add_svelte_meta(
	callback: () => any,
	type: DevStackEntry['type'],
	component: any,
	line: number,
	column: number,
	additional?: Record<string, any>
): any {
	const parent = dev_stack;

	dev_stack = {
		type,
		file: component[FILENAME],
		line,
		column,
		parent,
		...additional
	};

	try {
		return callback();
	} finally {
		dev_stack = parent;
	}
}

/**
 * The current component function. Different from current component context:
 * ```html
 * <!-- App.svelte -->
 * <Foo>
 *   <Bar /> <!-- context == Foo.svelte, function == App.svelte -->
 * </Foo>
 * ```
 */
export let dev_current_component_function: ComponentContext['function'] = null;

export function set_dev_current_component_function(fn: ComponentContext['function']): void {
	dev_current_component_function = fn;
}

/**
 * Returns a `[get, set, has]` triplet of functions for working with context in a type-safe way.
 *
 * `get` will throw an error if `set` has not yet been called in the current component or any of
 * its ancestors.
 *
 * @since 5.40.0
 */
export function createContext<T>(): [() => T, (context: T) => T, () => boolean] {
	return create_context<T>(getContext, setContext, hasContext);
}

/**
 * Retrieves the context set with the specified `key` in the current component or any of its
 * ancestors. If multiple components set the same key, the value from the closest one is returned.
 * A `setContext` call in the current component is only visible to `getContext` calls that run after it.
 * Must be called during component initialisation.
 *
 * [`createContext`](https://svelte.dev/docs/svelte/svelte#createContext) is a type-safe alternative.
 */
export function getContext<T>(key: any): T {
	const context_map = get_or_init_context_map(component_context, 'getContext');
	return context_map.get(key) as T;
}

/**
 * Associates an arbitrary `context` object with the current component and the specified `key`
 * and returns that object. The context is then available to the component itself and all of its
 * descendants (including slotted content) with `getContext`.
 *
 * Like lifecycle functions, this must be called during component initialisation.
 *
 * [`createContext`](https://svelte.dev/docs/svelte/svelte#createContext) is a type-safe alternative.
 */
export function setContext<T>(key: any, context: T): T {
	const context_map = get_or_init_context_map(component_context, 'setContext');
	context_map.set(key, context);
	return context;
}

/**
 * Checks whether a given `key` has been set in the context of the current component or any of
 * its ancestors. Must be called during component initialisation.
 */
export function hasContext(key: any): boolean {
	const context_map = get_or_init_context_map(component_context, 'hasContext');
	return context_map.has(key);
}

/**
 * Retrieves the whole context map that belongs to the current component, including entries
 * inherited from its ancestors. Must be called during component initialisation. Useful, for
 * example, if you programmatically create a component and want to pass the existing context to it.
 */
export function getAllContexts<T extends Map<any, any> = Map<any, any>>(): T {
	const context_map = get_or_init_context_map(component_context, 'getAllContexts');
	return context_map as T;
}

/**
 * The compiler passes the component's props, `runes` and, in dev, the component function, by
 * position. Only the last is used: the props were for `createEventDispatcher` and `runes` told
 * legacy components apart, both of which svelte-lite leaves out.
 */
export function push(props: Record<string, unknown>, runes?: unknown, fn?: Function): void {
	component_context = {
		p: component_context,
		i: false,
		c: null,
		e: null,
		r: active_effect as Effect
	};

	if (DEV) {
		// component function
		component_context.function = fn;
		dev_current_component_function = fn;
	}
}

export function pop<T extends Record<string, any>>(component?: T): T {
	var context = component_context as ComponentContext;
	var effects = context.e;

	// (`user_effect` is what puts them there)
	if (has_effects && effects !== null) {
		context.e = null;

		for (var fn of effects) {
			create_user_effect(fn);
		}
	}

	context.i = true;

	component_context = context.p;

	if (DEV) {
		dev_current_component_function = component_context?.function ?? null;
	}

	return mark_as_component(component);
}

/**
 * Add a symbol to the object (or create one if undefined) to mark it as a component so it isn't proxified.
 */
export function mark_as_component(component: any = {}): any {
	define_property(component, COMPONENT_SYMBOL, { value: true });
	return component;
}

/**
 * Every component is a runes component. The modules borrowed from Svelte still ask
 */
export function is_runes(): boolean {
	return true;
}
