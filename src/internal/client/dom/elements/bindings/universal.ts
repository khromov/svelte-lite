import { render_effect, teardown } from '../../../reactivity/effects.ts';
import { listen } from './shared.ts';

export function bind_content_editable(
	property: 'innerHTML' | 'textContent' | 'innerText',
	element: HTMLElement,
	get: () => unknown,
	set: (value: unknown) => void = get
): void {
	element.addEventListener('input', () => {
		set(element[property]);
	});

	render_effect(() => {
		var value = get();

		if (element[property] !== value) {
			if (value == null) {
				var non_null_value = element[property];
				set(non_null_value);
			} else {
				element[property] = value + '';
			}
		}
	});
}

export function bind_property(
	property: string,
	event_name: string,
	element: Element,
	set: (value: unknown) => void,
	get?: () => unknown
): void {
	var handler = () => {
		set((element as any)[property]);
	};

	element.addEventListener(event_name, handler);

	if (get) {
		render_effect(() => {
			(element as any)[property] = get();
		});
	} else {
		handler();
	}

	if (
		element === document.body ||
		// for `<svelte:window>` and `<svelte:document>` the compiler passes these as the element
		(element as unknown) === window ||
		(element as unknown) === document
	) {
		teardown(() => {
			element.removeEventListener(event_name, handler);
		});
	}
}

export function bind_focused(element: HTMLElement, set: (value: unknown) => void): void {
	listen(element, ['focus', 'blur'], () => {
		set(element === document.activeElement);
	});
}
