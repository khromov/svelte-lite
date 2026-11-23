import { teardown } from '../../reactivity/effects.ts';
import { array_from, define_property } from '../../../shared/utils.ts';
import { is_passive_event } from '../../../../utils.ts';
import { hydrating } from '../hydration.ts';
import { queue_micro_task } from '../task.ts';
import { FILENAME } from '../../../../constants.ts';
import * as w from '../../warnings.ts';
import {
	active_effect,
	active_reaction,
	set_active_effect,
	set_active_reaction
} from '../../runtime.ts';
import { without_reactive_context } from './bindings/shared.ts';

/**
 * Used on elements, as a map of event type -> event handler,
 * and on events themselves to track which element handled an event
 */
export const event_symbol = Symbol('events');

// The native listener boundary at which a delegated descendant stopped propagation.
const propagation_stopped_at = Symbol('propagation stopped at');

/** An element with handlers set through `delegated(...)` */
interface DelegatedTarget extends EventTarget {
	[event_symbol]?: Record<string, EventListener | null | undefined>;
	disabled?: boolean;
}

/** An event, with the notes that delegation leaves on it while it propagates */
interface DelegatedEvent extends Event {
	[event_symbol]?: EventTarget;
	[propagation_stopped_at]?: EventTarget;
}

/** The listener that `create_event` attaches, wrapping the handler it was given */
export interface TargetHandler {
	(this: EventTarget, event: Event): unknown;
	/** Set when the handler is removed before its deferred listener was attached */
	__removed?: boolean;
}

export const all_registered_events = new Set<string>();

export const root_event_handles = new Set<(events: Array<string>) => void>();

/**
 * SSR adds onload and onerror attributes to catch those events before the hydration.
 * This function detects those cases, removes the attributes and replays the events.
 */
export function replay_events(dom: HTMLElement): void {
	if (!hydrating) return;

	dom.removeAttribute('onload');
	dom.removeAttribute('onerror');

	const element = dom as HTMLElement & { __e?: Event };
	const event = element.__e;

	if (event !== undefined) {
		element.__e = undefined;
		queueMicrotask(() => {
			if (dom.isConnected) {
				dom.dispatchEvent(event);
			}
		});
	}
}

export function create_event(
	event_name: string,
	dom: EventTarget,
	handler?: EventListener,
	options: AddEventListenerOptions = {}
): TargetHandler {
	var target_handler: TargetHandler = function (event) {
		if (!options.capture) {
			// Only call in the bubble phase, else delegated events would be called before the capturing events
			handle_event_propagation.call(dom, event);
		}
		// Native stopPropagation() does not stop other listeners on the same element.
		// Only skip this callback if a delegated descendant stopped before reaching it.
		if (options.capture || (event as DelegatedEvent)[propagation_stopped_at] !== dom) {
			return without_reactive_context(() => {
				return handler?.call(this, event);
			});
		}
	};

	// Chrome has a bug where pointer events don't work when attached to a DOM element that has been cloned
	// with cloneNode() and the DOM element is disconnected from the document. To ensure the event works, we
	// defer the attachment till after it's been appended to the document. TODO: remove this once Chrome fixes
	// this bug. The same applies to wheel events and touch events.
	if (
		event_name.startsWith('pointer') ||
		event_name.startsWith('touch') ||
		event_name === 'wheel'
	) {
		target_handler.__removed = false;
		queue_micro_task(() => {
			if (!target_handler.__removed) {
				dom.addEventListener(event_name, target_handler, options);
			}
		});
	} else {
		dom.addEventListener(event_name, target_handler, options);
	}

	return target_handler;
}

/**
 * Attaches an event handler to the window and returns a function that removes the handler. Using this
 * rather than `addEventListener` will preserve the correct order relative to handlers added declaratively
 * (with attributes like `onclick`), which use event delegation for performance reasons
 */
export function on<Type extends keyof WindowEventMap>(
	window: Window,
	type: Type,
	handler: (this: Window, event: WindowEventMap[Type] & { currentTarget: Window }) => any,
	options?: AddEventListenerOptions | undefined
): () => void;
/**
 * Attaches an event handler to the document and returns a function that removes the handler. Using this
 * rather than `addEventListener` will preserve the correct order relative to handlers added declaratively
 * (with attributes like `onclick`), which use event delegation for performance reasons
 */
export function on<Type extends keyof DocumentEventMap>(
	document: Document,
	type: Type,
	handler: (this: Document, event: DocumentEventMap[Type] & { currentTarget: Document }) => any,
	options?: AddEventListenerOptions | undefined
): () => void;
/**
 * Attaches an event handler to an element and returns a function that removes the handler. Using this
 * rather than `addEventListener` will preserve the correct order relative to handlers added declaratively
 * (with attributes like `onclick`), which use event delegation for performance reasons
 */
export function on<Element extends HTMLElement, Type extends keyof HTMLElementEventMap>(
	element: Element,
	type: Type,
	handler: (this: Element, event: HTMLElementEventMap[Type] & { currentTarget: Element }) => any,
	options?: AddEventListenerOptions | undefined
): () => void;
/**
 * Attaches an event handler to an element and returns a function that removes the handler. Using this
 * rather than `addEventListener` will preserve the correct order relative to handlers added declaratively
 * (with attributes like `onclick`), which use event delegation for performance reasons
 */
export function on<Element extends MediaQueryList, Type extends keyof MediaQueryListEventMap>(
	element: Element,
	type: Type,
	handler: (this: Element, event: MediaQueryListEventMap[Type] & { currentTarget: Element }) => any,
	options?: AddEventListenerOptions | undefined
): () => void;
/**
 * Attaches an event handler to an element and returns a function that removes the handler. Using this
 * rather than `addEventListener` will preserve the correct order relative to handlers added declaratively
 * (with attributes like `onclick`), which use event delegation for performance reasons
 */
export function on(
	element: EventTarget,
	type: string,
	handler: EventListener,
	options?: AddEventListenerOptions | undefined
): () => void;
export function on(
	element: EventTarget,
	type: string,
	handler: EventListener,
	options: AddEventListenerOptions = {}
): () => void {
	var target_handler = create_event(type, element, handler, options);

	return () => {
		target_handler.__removed = true;
		element.removeEventListener(type, target_handler, options);
	};
}

export function event(
	event_name: string,
	dom: EventTarget,
	handler?: EventListener,
	capture?: boolean,
	passive?: boolean
): void {
	var options = { capture, passive };
	var target_handler = create_event(event_name, dom, handler, options);

	if (
		dom === document.body ||
		dom === window ||
		dom === document ||
		// Firefox has quirky behavior, it can happen that we still get "canplay" events when the element is already removed
		dom instanceof HTMLMediaElement
	) {
		teardown(() => {
			target_handler.__removed = true;
			dom.removeEventListener(event_name, target_handler, options);
		});
	}
}

export function delegated(event_name: string, element: Element, handler?: EventListener): void {
	((element as DelegatedTarget)[event_symbol] ??= {})[event_name] = handler;
}

export function delegate(events: Array<string>): void {
	for (var i = 0; i < events.length; i++) {
		all_registered_events.add(events[i]);
	}

	for (var fn of root_event_handles) {
		fn(events);
	}
}

/** How many delegation roots are listening to each event type on each node */
const delegated_listeners = new Map<EventTarget, Map<string, number>>();

/**
 * Makes `target` a root for delegated events: listens on `target` and on `document`
 * for every delegated event type, including types registered later, and dispatches
 * them to the handlers set with `delegated(...)`. Used for `mount`/`hydrate` targets.
 * @returns stops listening
 */
export function listen_to_delegated_events(target: EventTarget): () => void {
	var registered_events = new Set<string>();

	var event_handle = (events: Array<string>) => {
		for (var i = 0; i < events.length; i++) {
			var event_name = events[i];

			if (registered_events.has(event_name)) continue;
			registered_events.add(event_name);

			var passive = is_passive_event(event_name);

			// Add the event listener to both the target and the document.
			// The target listener ensures we catch events from within in case
			// the outer content stops propagation of the event.
			//
			// The document listener ensures we catch events that originate from elements that were
			// manually moved outside of the target (e.g. via manual portals).
			for (const node of [target, document]) {
				var counts = delegated_listeners.get(node);

				if (counts === undefined) {
					counts = new Map();
					delegated_listeners.set(node, counts);
				}

				var count = counts.get(event_name);

				if (count === undefined) {
					node.addEventListener(event_name, handle_event_propagation, { passive });
					counts.set(event_name, 1);
				} else {
					counts.set(event_name, count + 1);
				}
			}
		}
	};

	event_handle(array_from(all_registered_events));
	root_event_handles.add(event_handle);

	return () => {
		for (var event_name of registered_events) {
			for (const node of [target, document]) {
				var counts = delegated_listeners.get(node) as Map<string, number>;
				var count = counts.get(event_name) as number;

				if (--count == 0) {
					node.removeEventListener(event_name, handle_event_propagation);
					counts.delete(event_name);

					if (counts.size === 0) {
						delegated_listeners.delete(node);
					}
				} else {
					counts.set(event_name, count);
				}
			}
		}

		root_event_handles.delete(event_handle);
	};
}

// used to store the reference to the currently propagated event
// to prevent garbage collection between microtasks in Firefox (<= 141)
// If the event object is GCed too early, the expando __root property
// set on the event object is lost, causing the event delegation
// to process the event twice
let last_propagated_event: Event | null = null;

// whether a task is already queued to clear `last_propagated_event`
let last_propagated_event_clear_scheduled = false;

export function handle_event_propagation(this: EventTarget, event: DelegatedEvent): void {
	var handler_element = this;
	var was_stopped = event.cancelBubble;

	// Another listener at this boundary may already have dispatched the delegated
	// handler that stopped propagation. Do not dispatch it again.
	if (was_stopped && event[propagation_stopped_at] === handler_element) return;

	if (!was_stopped) {
		// The same event object may be dispatched again.
		delete event[propagation_stopped_at];
	}

	var owner_document = (handler_element as Node).ownerDocument;
	var event_name = event.type;
	var path = event.composedPath?.() || [];
	var current_target = (path[0] || event.target) as DelegatedTarget | null;

	last_propagated_event = event;

	// The reference is only needed while the event can still reach another
	// delegated root, i.e. during the current (synchronous) dispatch and its
	// microtask checkpoints. Clearing it in a later task preserves the
	// Firefox workaround while making sure the slot doesn't retain the last
	// event forever — through `event.target` it would otherwise keep the
	// entire detached subtree of whatever the user last clicked in alive
	// until the next delegated event happens to arrive.
	if (!last_propagated_event_clear_scheduled) {
		last_propagated_event_clear_scheduled = true;
		setTimeout(() => {
			last_propagated_event_clear_scheduled = false;
			last_propagated_event = null;
		});
	}

	// composedPath contains list of nodes the event has propagated through.
	// We check `event_symbol` to skip all nodes below it in case this is a
	// parent of the `event_symbol` node, which indicates that there's nested
	// mounted apps. In this case we don't want to trigger events multiple times.
	var path_idx = 0;

	// the `last_propagated_event === event` check is redundant, but
	// without it the variable will be DCE'd and things will
	// fail mysteriously in Firefox
	var handled_at = last_propagated_event === event && event[event_symbol];

	if (handled_at) {
		var at_idx = path.indexOf(handled_at);
		if (at_idx !== -1 && (handler_element === document || handler_element === window)) {
			// This is the fallback document listener or a window listener, but the event was already handled
			// -> ignore, but set handle_at to document/window so that we're resetting the event
			// chain in case someone manually dispatches the same event object again.
			event[event_symbol] = handler_element;
			return;
		}

		// We're deliberately not skipping if the index is higher, because
		// someone could create an event programmatically and emit it multiple times,
		// in which case we want to handle the whole propagation chain properly each time.
		// (this will only be a false negative if the event is dispatched multiple times and
		// the fallback document listener isn't reached in between, but that's super rare)
		var handler_idx = path.indexOf(handler_element);
		if (handler_idx === -1) {
			// handle_idx can theoretically be -1 (happened in some JSDOM testing scenarios with an event listener on the window object)
			// so guard against that, too, and assume that everything was handled at this point.
			return;
		}

		if (at_idx <= handler_idx) {
			path_idx = at_idx;
		}
	}

	current_target = (path[path_idx] || event.target) as DelegatedTarget | null;
	// there can only be one delegated event per element, and we either already handled the current target,
	// or this is the very first target in the chain which has a non-delegated listener, in which case it's safe
	// to handle a possible delegated event on it later (through the root delegation listener for example).
	if (current_target === handler_element) return;

	// Proxy currentTarget to correct target
	define_property(event, 'currentTarget', {
		configurable: true,
		get() {
			return current_target || owner_document;
		}
	});

	// This started because of Chromium issue https://chromestatus.com/feature/5128696823545856,
	// where removal or moving of the DOM can cause sync `blur` events to fire, which can cause logic
	// to run inside the current `active_reaction`, which isn't what we want at all. However, on reflection,
	// it's probably best that all events handled by Svelte have this behaviour, as we don't really want
	// an event handler to run in the context of another reaction or effect.
	var previous_reaction = active_reaction;
	var previous_effect = active_effect;
	set_active_reaction(null);
	set_active_effect(null);

	try {
		var throw_error: unknown;
		var other_errors: unknown[] = [];

		while (current_target !== null) {
			if (current_target === handler_element) break;

			try {
				var delegated = current_target[event_symbol]?.[event_name];

				if (
					delegated != null &&
					(!current_target.disabled ||
						// DOM could've been updated already by the time this is reached, so we check this as well
						// -> the target could not have been disabled because it emits the event in the first place
						event.target === current_target)
				) {
					delegated.call(current_target, event);
				}
			} catch (error) {
				if (throw_error) {
					other_errors.push(error);
				} else {
					throw_error = error;
				}
			}
			if (event.cancelBubble) {
				if (!was_stopped) {
					event[propagation_stopped_at] = handler_element;
				}
				break;
			}

			path_idx++;
			current_target = path_idx < path.length ? (path[path_idx] as DelegatedTarget) : null;
		}

		if (throw_error) {
			for (let error of other_errors) {
				// Throw the rest of the errors, one-by-one on a microtask
				queueMicrotask(() => {
					throw error;
				});
			}
			throw throw_error;
		}
	} finally {
		event[event_symbol] = handler_element;
		// remove proxy on currentTarget
		delete (event as { currentTarget?: unknown }).currentTarget;
		set_active_reaction(previous_reaction);
		set_active_effect(previous_effect);
	}
}

/**
 * In dev, warn if an event handler is not a function, as it means the
 * user probably called the handler or forgot to add a `() =>`
 */
export function apply(
	thunk: () => (event: Event, ...args: any) => void,
	element: EventTarget,
	args: [Event, ...any],
	component: any,
	loc?: [number, number],
	has_side_effects = false,
	remove_parens = false
): void {
	let handler;
	let error;

	try {
		handler = thunk();
	} catch (e) {
		error = e;
	}

	if (typeof handler !== 'function' && (has_side_effects || handler != null || error)) {
		const filename = component?.[FILENAME];
		const location = loc ? ` at ${filename}:${loc[0]}:${loc[1]}` : ` in ${filename}`;
		const phase = args[0]?.eventPhase < Event.BUBBLING_PHASE ? 'capture' : '';
		const event_name = args[0]?.type + phase;
		const description = `\`${event_name}\` handler${location}`;
		const suggestion = remove_parens ? 'remove the trailing `()`' : 'add a leading `() =>`';

		w.event_handler_invalid(description, suggestion);

		if (error) {
			throw error;
		}
	}
	handler?.apply(element, args);
}
