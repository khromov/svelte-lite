import { noop } from '../../../shared/utils.ts';
import { user_pre_effect } from '../../reactivity/effects.ts';
import { on } from '../elements/events.ts';

// The modifiers of an `on:` directive, which is deprecated and still valid in a runes
// component: `on:click|once|preventDefault={handler}` compiles to `$.once($.preventDefault(handler))`.
// `svelte/legacy` exports the same functions for components that were migrated by hand.

type Handler = (event: Event, ...args: unknown[]) => void;

/**
 * Substitute for the `trusted` event modifier
 * @deprecated
 */
export function trusted(fn: Handler): Handler {
	return function (this: unknown, ...args) {
		var event = args[0];
		if (event.isTrusted) {
			fn?.apply(this, args);
		}
	};
}

/**
 * Substitute for the `self` event modifier
 * @deprecated
 */
export function self(fn: Handler): Handler {
	return function (this: unknown, ...args) {
		var event = args[0];
		if (event.target === this) {
			fn?.apply(this, args);
		}
	};
}

/**
 * Substitute for the `stopPropagation` event modifier
 * @deprecated
 */
export function stopPropagation(fn: Handler): Handler {
	return function (this: unknown, ...args) {
		var event = args[0];
		event.stopPropagation();
		return fn?.apply(this, args);
	};
}

/**
 * Substitute for the `once` event modifier
 * @deprecated
 */
export function once(fn: Handler): Handler {
	var ran = false;

	return function (this: unknown, ...args) {
		if (ran) return;
		ran = true;

		return fn?.apply(this, args);
	};
}

/**
 * Substitute for the `stopImmediatePropagation` event modifier
 * @deprecated
 */
export function stopImmediatePropagation(fn: Handler): Handler {
	return function (this: unknown, ...args) {
		var event = args[0];
		event.stopImmediatePropagation();
		return fn?.apply(this, args);
	};
}

/**
 * Substitute for the `preventDefault` event modifier
 * @deprecated
 */
export function preventDefault(fn: Handler): Handler {
	return function (this: unknown, ...args) {
		var event = args[0];
		event.preventDefault();
		return fn?.apply(this, args);
	};
}

/**
 * Substitute for the `passive` event modifier, implemented as an action
 * @deprecated
 */
export function passive(
	node: HTMLElement,
	[event, handler]: [event: string, handler: () => EventListener]
): void {
	user_pre_effect(() => {
		return on(node, event, handler() ?? noop, {
			passive: true
		});
	});
}

/**
 * Substitute for the `nonpassive` event modifier, implemented as an action
 * @deprecated
 */
export function nonpassive(
	node: HTMLElement,
	[event, handler]: [event: string, handler: () => EventListener]
): void {
	user_pre_effect(() => {
		return on(node, event, handler() ?? noop, {
			passive: false
		});
	});
}
