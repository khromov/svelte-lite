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

/**
 * Used to simulate `$on` on a component instance when `compatibility.componentApi === 4`
 */
export function add_legacy_event_listener(
	$$props: Record<string, any>,
	event_name: string,
	event_callback: Function
): void {
	$$props.$$events ||= {};
	$$props.$$events[event_name] ||= [];
	$$props.$$events[event_name].push(event_callback);
}

/**
 * Used to simulate `$set` on a component instance when `compatibility.componentApi === 4`.
 * Needs component accessors so that it can call the setter of the prop. Therefore doesn't
 * work for updating props in `$$props` or `$$restProps`.
 */
export function update_legacy_props(
	this: Record<string, any>,
	$$new_props: Record<string, any>
): void {
	for (var key in $$new_props) {
		if (key in this) {
			this[key] = $$new_props[key];
		}
	}
}
