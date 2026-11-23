import { teardown } from '../../../reactivity/effects.ts';
import {
	active_effect,
	active_reaction,
	set_active_effect,
	set_active_reaction
} from '../../../runtime.ts';
import { FORM_RESET_HANDLER } from '../../../constants.ts';
import { add_form_reset_listener } from '../misc.ts';

/**
 * Fires the handler once immediately (unless corresponding arg is set to `false`),
 * then listens to the given events until the render effect context is destroyed
 */
export function listen(
	target: EventTarget,
	events: string[],
	handler: (event?: Event) => void,
	call_handler_immediately: boolean = true
): void {
	if (call_handler_immediately) {
		handler();
	}

	for (var name of events) {
		target.addEventListener(name, handler);
	}

	teardown(() => {
		for (var name of events) {
			target.removeEventListener(name, handler);
		}
	});
}

export function without_reactive_context<T>(fn: () => T): T {
	var previous_reaction = active_reaction;
	var previous_effect = active_effect;
	set_active_reaction(null);
	set_active_effect(null);
	try {
		return fn();
	} finally {
		set_active_reaction(previous_reaction);
		set_active_effect(previous_effect);
	}
}

/**
 * Listen to the given event, and then instantiate a global form reset listener if not already done,
 * to notify all bindings when the form is reset.
 *
 * Svelte takes a second handler for the reset from the bindings that need one. Here the one
 * handler of a binding does both: it is called with `true` for a reset, a tick after the
 * event, when the elements of the form have their defaults again. No reaction is running
 * then, which an event that is dispatched from an effect cannot be sure of
 */
export function listen_to_event_and_reset_event(
	element: HTMLElement & { [FORM_RESET_HANDLER]?: () => void },
	event: string,
	handler: (is_reset?: true) => void
): void {
	element.addEventListener(event, () => without_reactive_context(handler));

	// The element has a reset handler already if it is a checkbox with both `bind:group` and
	// `bind:checked`, or an input that `remove_input_defaults` looks after while hydrating
	var prev = element[FORM_RESET_HANDLER];

	element[FORM_RESET_HANDLER] = () => {
		prev?.();
		handler(true);
	};

	add_form_reset_listener();
}
