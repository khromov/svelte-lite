import { listen, without_reactive_context } from './shared.ts';

export function bind_active_element(update: (active_element: Element | null) => void): void {
	listen(document, ['focusin', 'focusout'], (event) => {
		if (event && event.type === 'focusout' && (event as FocusEvent).relatedTarget) {
			// The tests still pass if we remove this, because of JSDOM limitations, but it is necessary
			// to avoid temporarily resetting to `document.body`
			return;
		}

		// Removing the focused element fires `focusout` while an effect is running
		without_reactive_context(() => update(document.activeElement));
	});
}
