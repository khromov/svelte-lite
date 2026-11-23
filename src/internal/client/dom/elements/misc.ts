import { FORM_RESET_HANDLER } from '../../constants.ts';
import { hydrating } from '../hydration.ts';
import { clear_text_content, get_first_child } from '../operations.ts';
import { queue_micro_task } from '../task.ts';

export function autofocus(dom: HTMLElement, value: boolean): void {
	if (value) {
		const body = document.body;
		dom.autofocus = true;

		queue_micro_task(() => {
			if (document.activeElement === body) {
				dom.focus();
			}
		});
	}
}

/**
 * The child of a textarea actually corresponds to the defaultValue property, so we need
 * to remove it upon hydration to avoid a bug when someone resets the form value.
 */
export function remove_textarea_child(dom: HTMLTextAreaElement): void {
	if (hydrating && get_first_child(dom) !== null) {
		clear_text_content(dom);
	}
}

let listening_to_form_reset = false;

export function add_form_reset_listener(): void {
	if (!listening_to_form_reset) {
		listening_to_form_reset = true;
		document.addEventListener(
			'reset',
			(evt) => {
				// Needs to happen one tick later or else the dom properties of the form
				// elements have not updated to their reset values yet
				Promise.resolve().then(() => {
					if (!evt.defaultPrevented) {
						for (const e of (evt.target as HTMLFormElement).elements) {
							(e as any)[FORM_RESET_HANDLER]?.();
						}
					}
				});
			},
			// In the capture phase to guarantee we get noticed of it (no possibility of stopPropagation)
			{ capture: true }
		);
	}
}
