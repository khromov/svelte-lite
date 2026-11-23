import { effect, teardown } from '../../../reactivity/effects.ts';
import { listen_to_event } from './shared.ts';
import { is } from '../../../proxy.ts';
import { is_array } from '../../../../shared/utils.ts';
import * as w from '../../../warnings.ts';

/**
 * `__value` is the value that was last set or bound, which compiled code and attribute
 * spreading write too. `__defaultValue` is the one a form reset restores
 */
type Select = HTMLSelectElement & { __value?: unknown; __defaultValue?: unknown };

/**
 * Sets the `selected` attribute on an option so form reset can restore it.
 */
export function set_selected(option: HTMLOptionElement, selected: boolean): void {
	if (selected) {
		// The selected option could've changed via user selection, and
		// setting the value without this check would set it back.
		if (!option.hasAttribute('selected')) {
			option.setAttribute('selected', '');
		}
	} else {
		option.removeAttribute('selected');
	}
}

/**
 * Sets the options a form reset should restore. The first call selects
 * them if nothing has set a value, later calls leave the current selection alone.
 */
export function set_default_select_value(select: Select, value: any): void {
	var mounting = !('__defaultValue' in select);
	if (!mounting && select.__defaultValue === value) return;
	select.__defaultValue = value;
	apply_default_select_value(select, !mounting || '__value' in select);
}

/**
 * Marks the options matching `__defaultValue` as selected. Without `preserve`
 * a newly matching option gets selected, as an inserted `<option selected>` would.
 */
function apply_default_select_value(select: Select, preserve: boolean): void {
	var value: any = select.__defaultValue;
	var multiple = select.multiple;
	var values = multiple ? value ?? [] : null;

	if (multiple && !is_array(values)) return;

	var index = select.selectedIndex;
	var selected = preserve && multiple ? new Set(select.selectedOptions) : null;

	for (var option of select.options) {
		var option_value = get_option_value(option);
		set_selected(
			option,
			multiple ? (values as any[]).includes(option_value) : is(option_value, value)
		);
	}

	if (!preserve) return;

	if (selected !== null) {
		for (option of select.options) {
			var was_selected = selected.has(option);
			if (option.selected !== was_selected) option.selected = was_selected;
		}
	} else if (select.selectedIndex !== index) {
		select.selectedIndex = index;
	}
}

/**
 * Selects the correct option(s) (depending on whether this is a multiple select)
 */
export function select_option<V>(
	select: HTMLSelectElement,
	value: V,
	mounting: boolean = false
): void {
	if (select.multiple) {
		// If value is null or undefined, keep the selection as is
		if (value == undefined) {
			return;
		}

		// If not an array, warn and keep the selection as is
		if (!is_array(value)) {
			return w.select_multiple_invalid_value();
		}

		// Otherwise, update the selection
		for (var option of select.options) {
			option.selected = value.includes(get_option_value(option));
		}

		return;
	}

	for (option of select.options) {
		var option_value = get_option_value(option);
		if (is(option_value, value)) {
			option.selected = true;
			return;
		}
	}

	if (!mounting || value !== undefined) {
		select.selectedIndex = -1; // no option should be selected
	}
}

/**
 * Sets up a mutation observer to sync the current selection
 * and default to the dom when the options change, for example
 * when they are inside an `#each` block. Called once per `<select>`,
 * by the compiled output or by `attribute_effect` for spreads.
 */
export function init_select(select: Select): void {
	var observer = new MutationObserver((entries) => {
		// Mutations related to `<selectedcontent>` can never affect the option list.
		// Reacting to them could revert a user-initiated selection change, because the
		// records are delivered as soon as any listener returns (e.g. a delegated `input`
		// handler), which can happen before the `change` handler has updated `__value`
		if (entries.every(is_selectedcontent_mutation)) return;

		if ('__defaultValue' in select) {
			apply_default_select_value(select, false);
		}

		if ('__value' in select) {
			select_option(select, select.__value);
		}
		// Deliberately don't update the potential binding value,
		// the model should be preserved unless explicitly changed
	});

	observer.observe(select, {
		// Listen to option element changes
		childList: true,
		subtree: true, // because of <optgroup>
		// Listen to option element value attribute changes
		// (doesn't get notified of select value changes,
		// because that property is not reflected as an attribute)
		attributes: true,
		attributeFilter: ['value']
	});

	teardown(() => {
		observer.disconnect();
	});
}

export function bind_select_value(
	select: Select,
	get: () => unknown,
	set: (value: unknown) => void = get
): void {
	var mounting = true;

	listen_to_event(select, 'change', () => {
		var value: unknown;

		if (select.multiple) {
			value = Array.from(select.querySelectorAll<HTMLOptionElement>(':checked'), get_option_value);
		} else {
			var selected_option: HTMLOptionElement | null =
				select.querySelector(':checked') ??
				// will fall back to first non-disabled option if no option is selected
				select.querySelector('option:not([disabled])');
			value = selected_option && get_option_value(selected_option);
		}

		set(value);

		select.__value = value;
	});

	// Needs to be an effect, not a render_effect, so that in case of each loops the logic runs after the each block has updated
	effect(() => {
		var value = get();

		// Svelte returns here for a focused select while the batch that its own `change` event
		// started is flushed, for the sake of pending async batches. That is left out with
		// async, so the select shows the bound value also when the setter changed the choice

		select_option(select, value, mounting);

		// Mounting and value undefined -> take selection from dom
		if (mounting && value === undefined) {
			var selected_option: HTMLOptionElement | null = select.querySelector(':checked');
			if (selected_option !== null) {
				value = get_option_value(selected_option);
				set(value);
			}
		}

		select.__value = value;
		mounting = false;
	});
}

function get_option_value(option: HTMLOptionElement & { __value?: unknown }): unknown {
	// __value only exists if the <option> has a value attribute
	if ('__value' in option) {
		return option.__value;
	} else {
		return option.value;
	}
}

/**
 * Returns `true` if the mutation stems from the browser mirroring the selected
 * option's content into `<selectedcontent>`, or from us replacing the
 * `<selectedcontent>` element with a clone of itself
 */
function is_selectedcontent_mutation(entry: MutationRecord): boolean {
	if ((entry.target as Element).closest('selectedcontent') !== null) {
		return true;
	}

	if (entry.type === 'childList') {
		var nodes = [...entry.addedNodes, ...entry.removedNodes];
		return nodes.length > 0 && nodes.every((node) => node.nodeName === 'SELECTEDCONTENT');
	}

	return false;
}
