import { is_array } from '../../../shared/utils.ts';

// What is here serves deprecated syntax that a runes component can still use. Upstream's
// `reactive_import` is left out: only a legacy mode component is compiled to a call of it.

/**
 * Calls the handlers that the parent passed for an event that the component forwards,
 * as in `<button on:click>`
 */
export function bubble_event(this: any, $$props: Record<string, unknown>, event: Event): void {
	var events = ($$props.$$events as Record<string, Function[] | Function> | undefined)?.[
		event.type
	];

	var callbacks = is_array(events) ? events.slice() : events == null ? [] : [events];

	for (var fn of callbacks) {
		// Preserve "this" context
		fn.call(this, event);
	}
}
