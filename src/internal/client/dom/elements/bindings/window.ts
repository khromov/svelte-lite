import { effect, render_effect, teardown } from '../../../reactivity/effects.ts';
import { listen, without_reactive_context } from './shared.ts';

export function bind_window_scroll(
	type: 'x' | 'y',
	get: () => number,
	set: (value: number) => void = get
): void {
	var is_scrolling_x = type === 'x';

	var target_handler = () =>
		without_reactive_context(() => {
			scrolling = true;
			clearTimeout(timeout);
			timeout = setTimeout(clear, 100); // TODO use scrollend event if supported (or when supported everywhere?)

			set(window[is_scrolling_x ? 'scrollX' : 'scrollY']);
		});

	addEventListener('scroll', target_handler, {
		passive: true
	});

	var scrolling = false;

	var timeout: ReturnType<typeof setTimeout>;
	var clear = () => {
		scrolling = false;
	};
	var first = true;

	render_effect(() => {
		var latest_value = get();
		// Don't scroll to the initial value for accessibility reasons
		if (first) {
			first = false;
		} else if (!scrolling && latest_value != null) {
			scrolling = true;
			clearTimeout(timeout);
			if (is_scrolling_x) {
				scrollTo(latest_value, window.scrollY);
			} else {
				scrollTo(window.scrollX, latest_value);
			}
			timeout = setTimeout(clear, 100);
		}
	});

	// Browsers don't fire the scroll event for the initial scroll position when scroll style isn't set to smooth
	effect(target_handler);

	teardown(() => {
		removeEventListener('scroll', target_handler);
	});
}

export function bind_window_size(
	type: 'innerWidth' | 'innerHeight' | 'outerWidth' | 'outerHeight',
	set: (size: number) => void
): void {
	listen(window, ['resize'], () => without_reactive_context(() => set(window[type])));
}
