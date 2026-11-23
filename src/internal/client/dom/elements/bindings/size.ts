import { effect, teardown } from '../../../reactivity/effects.ts';
import { untrack } from '../../../runtime.ts';

type Listener = (entry: ResizeObserverEntry) => unknown;

/**
 * We create one observer for all elements that are observed with the same `box`.
 * This is a function and not a class, as it is in Svelte, because it minifies better.
 * Returns the function that starts observing an element, which returns the one that stops it
 * @see {@link https://groups.google.com/a/chromium.org/g/blink-dev/c/z6ienONUb5A/m/F5-VcUZtBAAJ Explanation}
 */
function resize_observer(box: ResizeObserverBoxOptions) {
	var all = new WeakMap<Element, Set<Listener>>();
	var observer: ResizeObserver | undefined;

	return (element: Element, listener: Listener): (() => void) => {
		var listeners = all.get(element) || new Set();
		listeners.add(listener);

		all.set(element, listeners);

		(observer ??= new ResizeObserver((entries) => {
			for (var entry of entries) {
				for (var listener of all.get(entry.target) || []) {
					listener(entry);
				}
			}
		})).observe(element, { box });

		return () => {
			var listeners = all.get(element)!;
			listeners.delete(listener);

			if (listeners.size === 0) {
				all.delete(element);
				observer!.unobserve(element);
			}
		};
	};
}

var observe_content_box = /* @__PURE__ */ resize_observer('content-box');

var observe_border_box = /* @__PURE__ */ resize_observer('border-box');

var observe_device_pixel_content_box = /* @__PURE__ */ resize_observer('device-pixel-content-box');

export function bind_resize_observer(
	element: Element,
	type: 'contentRect' | 'contentBoxSize' | 'borderBoxSize' | 'devicePixelContentBoxSize',
	set: (value: ResizeObserverEntry[typeof type]) => void
): void {
	var observe =
		type === 'contentRect' || type === 'contentBoxSize'
			? observe_content_box
			: type === 'borderBoxSize'
				? observe_border_box
				: observe_device_pixel_content_box;

	teardown(observe(element, (entry) => set(entry[type])));
}

export function bind_element_size(
	element: HTMLElement,
	type: 'clientWidth' | 'clientHeight' | 'offsetWidth' | 'offsetHeight',
	set: (size: number) => void
): void {
	var unsub = observe_border_box(element, () => set(element[type]));

	effect(() => {
		// The update could contain reads which should be ignored
		untrack(() => set(element[type]));
		return unsub;
	});
}
