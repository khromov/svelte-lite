import { teardown } from '../../reactivity/effects.ts';
import { hydrating } from '../hydration.ts';
import { queue_micro_task } from '../task.ts';
import { FILENAME } from '../../../../constants.ts';
import * as w from '../../warnings.ts';
import { without_reactive_context } from './bindings/shared.ts';

// svelte-lite does not delegate events. Every handler is a listener on the element it was
// written on, so the order in which handlers run, `currentTarget` and `stopPropagation()`
// are the browser's own.

/** The listener that `create_event` attaches, wrapping the handler it was given */
export interface TargetHandler {
	(this: EventTarget, event: Event): unknown;
	/** Set when the handler is removed before its deferred listener was attached */
	__removed?: boolean;
}

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
		// an event handler does not run in the context of whichever reaction or effect
		// happened to cause the event (removing a focused element fires `blur` synchronously)
		return without_reactive_context(() => {
			return handler?.call(this, event);
		});
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
 * Attaches an event handler to the window and returns a function that removes the handler. The handler
 * runs outside of any reactive context, like the ones added declaratively (with attributes like `onclick`)
 */
export function on<Type extends keyof WindowEventMap>(
	window: Window,
	type: Type,
	handler: (this: Window, event: WindowEventMap[Type] & { currentTarget: Window }) => any,
	options?: AddEventListenerOptions | undefined
): () => void;
/**
 * Attaches an event handler to the document and returns a function that removes the handler. The handler
 * runs outside of any reactive context, like the ones added declaratively (with attributes like `onclick`)
 */
export function on<Type extends keyof DocumentEventMap>(
	document: Document,
	type: Type,
	handler: (this: Document, event: DocumentEventMap[Type] & { currentTarget: Document }) => any,
	options?: AddEventListenerOptions | undefined
): () => void;
/**
 * Attaches an event handler to an element and returns a function that removes the handler. The handler
 * runs outside of any reactive context, like the ones added declaratively (with attributes like `onclick`)
 */
export function on<Element extends HTMLElement, Type extends keyof HTMLElementEventMap>(
	element: Element,
	type: Type,
	handler: (this: Element, event: HTMLElementEventMap[Type] & { currentTarget: Element }) => any,
	options?: AddEventListenerOptions | undefined
): () => void;
/**
 * Attaches an event handler to an element and returns a function that removes the handler. The handler
 * runs outside of any reactive context, like the ones added declaratively (with attributes like `onclick`)
 */
export function on<Element extends MediaQueryList, Type extends keyof MediaQueryListEventMap>(
	element: Element,
	type: Type,
	handler: (this: Element, event: MediaQueryListEventMap[Type] & { currentTarget: Element }) => any,
	options?: AddEventListenerOptions | undefined
): () => void;
/**
 * Attaches an event handler to an element and returns a function that removes the handler. The handler
 * runs outside of any reactive context, like the ones added declaratively (with attributes like `onclick`)
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

/**
 * The compiler emits this instead of `event(...)` for the events that Svelte delegates
 * (`click`, `input`, `keydown` and so on), which is only ever on an element and never with
 * `capture`. Here the handler is attached to the element itself.
 */
export function delegated(
	event_name: string,
	element: Element,
	handler?: EventListener,
	capture?: boolean,
	passive?: boolean
): void {
	create_event(event_name, element, handler, { passive });
}

/**
 * The compiler emits this once per module, with the events it used `delegated(...)` for.
 * There is no root listener to register them with.
 */
export function delegate(events: Array<string>): void {}

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
		// a handler on the element that the event was dispatched to runs in the target phase,
		// whether it listens with `capture` or not. Without delegation that is the usual case
		const phase = args[0]?.eventPhase === Event.CAPTURING_PHASE ? 'capture' : '';
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
