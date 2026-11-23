import { teardown } from '../../../reactivity/effects.ts';
import {
	active_effect,
	active_reaction,
	set_active_effect,
	set_active_reaction
} from '../../../runtime.ts';

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
 * Listen to the given event for as long as the element lives. Svelte also notifies the
 * binding when the element's form is reset, which is left out: after `form.reset()` the
 * bound state keeps its value until the next event from the element
 */
export function listen_to_event(element: HTMLElement, event: string, handler: () => void): void {
	element.addEventListener(event, () => without_reactive_context(handler));
}
