import type { Action, ActionReturn } from '../action/public.ts';
import type { Attachment } from './public.ts';
import { ATTACHMENT_KEY } from '../constants.ts';
import { noop } from '../internal/shared/utils.ts';
import { render_effect, teardown } from '../internal/client/reactivity/effects.ts';
import { untrack } from '../internal/client/runtime.ts';

// `svelte/attachments` is this module, so the type has to be importable from here
export type { Attachment };

/**
 * Creates an object key that will be recognised as an attachment when the object is spread onto an element,
 * as a programmatic alternative to using `{@attach ...}`. This can be useful for library authors, though
 * is generally not needed when building an app.
 *
 * ```svelte
 * <script>
 * 	import { createAttachmentKey } from 'svelte/attachments';
 *
 * 	const props = {
 * 		class: 'cool',
 * 		onclick: () => alert('clicked'),
 * 		[createAttachmentKey()]: (node) => {
 * 			node.textContent = 'attached!';
 * 		}
 * 	};
 * </script>
 *
 * <button {...props}>click me</button>
 * ```
 * @since 5.29
 */
export function createAttachmentKey(): symbol {
	return Symbol(ATTACHMENT_KEY);
}

/**
 * Converts an [action](https://svelte.dev/docs/svelte/use) into an [attachment](https://svelte.dev/docs/svelte/@attach) keeping the same behavior.
 * It's useful if you want to start using attachments on components but you have actions provided by a library.
 *
 * Note that the second argument, if provided, must be a function that _returns_ the argument to the
 * action function, not the argument itself.
 *
 * ```svelte
 * <!-- with an action -->
 * <div use:foo={bar}>...</div>
 *
 * <!-- with an attachment -->
 * <div {@attach fromAction(foo, () => bar)}>...</div>
 * ```
 * @param action The action function
 * @param fn A function that returns the argument for the action
 * @since 5.32
 */
export function fromAction<E extends EventTarget, T extends unknown>(
	action: Action<E, T> | ((element: E, arg: T) => void | ActionReturn<T>),
	fn: () => T
): Attachment<E>;
/**
 * Converts an [action](https://svelte.dev/docs/svelte/use) into an [attachment](https://svelte.dev/docs/svelte/@attach) keeping the same behavior.
 * It's useful if you want to start using attachments on components but you have actions provided by a library.
 *
 * Note that the second argument, if provided, must be a function that _returns_ the argument to the
 * action function, not the argument itself.
 *
 * ```svelte
 * <!-- with an action -->
 * <div use:foo={bar}>...</div>
 *
 * <!-- with an attachment -->
 * <div {@attach fromAction(foo, () => bar)}>...</div>
 * ```
 * @param action The action function
 * @since 5.32
 */
export function fromAction<E extends EventTarget>(
	action: Action<E, void> | ((element: E) => void | ActionReturn<void>)
): Attachment<E>;
export function fromAction<E extends EventTarget, T extends unknown>(
	action: (element: E, arg: T) => void | ActionReturn<T>,
	fn: () => T = noop as () => T
): Attachment<E> {
	return (element) => {
		const { update, destroy } = untrack(() => action(element, fn()) ?? ({} as ActionReturn<T>));

		if (update) {
			var ran = false;
			render_effect(() => {
				const arg = fn();
				if (ran) update(arg);
			});
			ran = true;
		}

		if (destroy) {
			teardown(destroy);
		}
	};
}
