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
 * to notify all bindings when the form is reset
 */
export function listen_to_event_and_reset_event(
	element: HTMLElement & { [FORM_RESET_HANDLER]?: () => void },
	event: string,
	handler: (is_reset?: true) => void,
	on_reset: (is_reset?: true) => void = handler
): void {
	element.addEventListener(event, () => without_reactive_context(handler));
	const prev = element[FORM_RESET_HANDLER];
	if (prev) {
		// special case for checkbox that can have multiple binds (group & checked)
		element[FORM_RESET_HANDLER] = () => {
			prev();
			on_reset(true);
		};
	} else {
		element[FORM_RESET_HANDLER] = () => on_reset(true);
	}

	add_form_reset_listener();
}
