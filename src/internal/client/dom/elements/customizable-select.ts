import { hydrating, reset, set_hydrate_node, set_hydrating } from '../hydration.ts';
import { create_comment, create_element } from '../operations.ts';
import { create_trusted_html } from '../reconciler.ts';
import { attach } from './attachments.ts';

let supported: boolean | null = null;

/**
 * Checks if the browser supports rich HTML content inside `<option>` elements.
 * Modern browsers preserve HTML elements inside options, while older browsers
 * strip them during parsing, leaving only text content.
 */
function is_supported(): boolean {
	if (supported === null) {
		var select = create_element('select');
		select.innerHTML = create_trusted_html('<option><span>t</span></option>');
		supported = select.firstChild?.firstChild?.nodeType === 1;
	}

	return supported;
}

export function selectedcontent(
	element: HTMLElement,
	update_element: (new_element: HTMLElement) => void
): void {
	// if it's not supported no need for special logic
	if (!is_supported()) return;

	// we use the attach function directly just to make sure is executed when is mounted to the dom
	attach(element, () => () => {
		const select = element.closest('select');
		if (!select) return;

		const observer = new MutationObserver((entries) => {
			var selected = false;

			for (const entry of entries) {
				if (entry.target === element) {
					// the `<selectedcontent>` already changed, no need to replace it
					return;
				}

				// if the changes doesn't include the selected `<option>` we don't need to do anything
				selected ||= !!entry.target.parentElement?.closest('option')?.selected;
			}

			if (selected) {
				// replace the `<selectedcontent>` with a clone
				element.replaceWith((element = element.cloneNode(true) as HTMLElement));
				update_element(element);
			}
		});

		observer.observe(select, {
			childList: true,
			characterData: true,
			subtree: true
		});

		return () => {
			observer.disconnect();
		};
	});
}

/**
 * Handles rich HTML content inside `<option>`, `<optgroup>`, or `<select>` elements with browser-specific branching.
 * Modern browsers preserve HTML inside options, while older browsers strip it to text only.
 *
 * @param element The element to process
 * @param rich_fn Function to process rich HTML content (modern browsers)
 */
export function customizable_select(
	element: HTMLOptionElement | HTMLOptGroupElement | HTMLSelectElement,
	rich_fn: () => void
): void {
	var was_hydrating = hydrating;

	if (!is_supported()) {
		set_hydrating(false);
		element.textContent = '';
		element.append(create_comment(''));
	}

	try {
		rich_fn();
	} finally {
		if (was_hydrating) {
			if (hydrating) {
				reset(element);
			} else {
				set_hydrating(true);
				set_hydrate_node(element);
			}
		}
	}
}
