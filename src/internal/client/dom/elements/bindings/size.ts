import { effect, teardown } from '../../../reactivity/effects.ts';
import { untrack } from '../../../runtime.ts';

type Listener = (entry: ResizeObserverEntry) => unknown;

/**
 * We create one listener for all elements
 * @see {@link https://groups.google.com/a/chromium.org/g/blink-dev/c/z6ienONUb5A/m/F5-VcUZtBAAJ Explanation}
 */
class ResizeObserverSingleton {
	#listeners = new WeakMap<Element, Set<Listener>>();

	#observer: ResizeObserver | undefined;

	#options: ResizeObserverOptions;

	static entries = new WeakMap<Element, ResizeObserverEntry>();

	constructor(options: ResizeObserverOptions) {
		this.#options = options;
	}

	observe(element: Element, listener: Listener): () => void {
		var listeners = this.#listeners.get(element) || new Set();
		listeners.add(listener);

		this.#listeners.set(element, listeners);
		this.#getObserver().observe(element, this.#options);

		return () => {
			var listeners = this.#listeners.get(element)!;
			listeners.delete(listener);

			if (listeners.size === 0) {
				this.#listeners.delete(element);
				this.#observer!.unobserve(element);
			}
		};
	}

	#getObserver(): ResizeObserver {
		return (
			this.#observer ??
			(this.#observer = new ResizeObserver((entries) => {
				for (var entry of entries) {
					ResizeObserverSingleton.entries.set(entry.target, entry);
					for (var listener of this.#listeners.get(entry.target) || []) {
						listener(entry);
					}
				}
			}))
		);
	}
}

var resize_observer_content_box = /* @__PURE__ */ new ResizeObserverSingleton({
	box: 'content-box'
});

var resize_observer_border_box = /* @__PURE__ */ new ResizeObserverSingleton({
	box: 'border-box'
});

var resize_observer_device_pixel_content_box = /* @__PURE__ */ new ResizeObserverSingleton({
	box: 'device-pixel-content-box'
});

export function bind_resize_observer(
	element: Element,
	type: 'contentRect' | 'contentBoxSize' | 'borderBoxSize' | 'devicePixelContentBoxSize',
	set: (value: ResizeObserverEntry[typeof type]) => void
): void {
	var observer =
		type === 'contentRect' || type === 'contentBoxSize'
			? resize_observer_content_box
			: type === 'borderBoxSize'
				? resize_observer_border_box
				: resize_observer_device_pixel_content_box;

	var unsub = observer.observe(element, (entry) => set(entry[type]));
	teardown(unsub);
}

export function bind_element_size(
	element: HTMLElement,
	type: 'clientWidth' | 'clientHeight' | 'offsetWidth' | 'offsetHeight',
	set: (size: number) => void
): void {
	var unsub = resize_observer_border_box.observe(element, () => set(element[type]));

	effect(() => {
		// The update could contain reads which should be ignored
		untrack(() => set(element[type]));
		return unsub;
	});
}
