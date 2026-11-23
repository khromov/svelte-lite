import { DEV } from 'esm-env';
import { render_effect, teardown } from '../../../reactivity/effects.ts';
import { listen_to_event } from './shared.ts';
import * as e from '../../../errors.ts';
import { is } from '../../../proxy.ts';
import { queue_micro_task } from '../../task.ts';
import { hydrating } from '../../hydration.ts';
import { untrack } from '../../../runtime.ts';

/** `__value` is where compiled code and attribute spreading keep the `value` of an input, as it was given */
type Input = HTMLInputElement & { __value?: unknown };

export function bind_value(
	input: HTMLInputElement,
	get: () => unknown,
	set: (value: unknown) => void = get
): void {
	listen_to_event(input, 'input', () => {
		if (DEV && input.type === 'checkbox') {
			// TODO should this happen in prod too?
			e.bind_invalid_checkbox_value();
		}

		set(is_numberlike_input(input) ? to_number(input.value) : input.value);

		// Svelte waits a tick here, and if `get()` then gives something else than what was
		// typed (the setter changed or refused it), writes that back to the input and restores
		// the selection. That is left out, with the `tick` and `flushSync` it needs: the effect
		// below writes to the input when the bound value changes, and until then the input
		// keeps what was typed
	});

	if (
		// If we are hydrating and the value has since changed,
		// then use the updated value from the input instead.
		(hydrating && input.defaultValue !== input.value) ||
		// If defaultValue is set, then value == defaultValue
		// TODO Svelte 6: remove input.value check and set to empty string?
		(untrack(get) == null && input.value)
	) {
		set(is_numberlike_input(input) ? to_number(input.value) : input.value);
	}

	render_effect(() => {
		if (DEV && input.type === 'checkbox') {
			// TODO should this happen in prod too?
			e.bind_invalid_checkbox_value();
		}

		var value = get();

		// Svelte returns here for a focused input while the batch that its own `input` event
		// started is flushed, so that a pending async batch cannot overwrite what is being
		// typed. That is left out with async, so a value that the setter coerced is written
		// below, and the caret ends up at the end of the input

		if (is_numberlike_input(input) && value === to_number(input.value)) {
			// handles 0 vs 00 case (see https://github.com/sveltejs/svelte/issues/9959)
			return;
		}

		if (input.type === 'date' && !value && !input.value) {
			// Handles the case where a temporarily invalid date is set (while typing, for example with a leading 0 for the day)
			// and prevents this state from clearing the other parts of the date input (see https://github.com/sveltejs/svelte/issues/7897)
			return;
		}

		// don't set the value of the input if it's the same to allow
		// minlength to work properly
		if (value !== input.value) {
			// the value is coerced on assignment
			input.value = (value ?? '') as string;
		}
	});
}

const pending = new Set<HTMLInputElement[]>();

export function bind_group(
	inputs: HTMLInputElement[],
	group_index: null | [number],
	input: Input,
	get: () => unknown,
	set: (value: unknown) => void = get
): void {
	var is_checkbox = input.getAttribute('type') === 'checkbox';
	var binding_group: Input[] = inputs;

	// needs to be let or related code isn't treeshaken out if it's always false
	let hydration_mismatch = false;

	if (group_index !== null) {
		for (var index of group_index) {
			// inside each blocks `inputs` is nested, with one level per index
			binding_group = (binding_group as any)[index] ??= [];
		}
	}

	binding_group.push(input);

	listen_to_event(input, 'change', () => {
		var value = input.__value;

		if (is_checkbox) {
			value = get_binding_group_value(binding_group, value, input.checked);
		}

		set(value);
	});

	render_effect(() => {
		var value = get();

		// If we are hydrating and the value has since changed, then use the update value
		// from the input instead.
		if (hydrating && input.defaultChecked !== input.checked) {
			hydration_mismatch = true;
			return;
		}

		if (is_checkbox) {
			value = value || [];
			input.checked = (value as unknown[]).includes(input.__value);
		} else {
			input.checked = is(input.__value, value);
		}
	});

	teardown(() => {
		var index = binding_group.indexOf(input);

		if (index !== -1) {
			binding_group.splice(index, 1);
		}
	});

	if (!pending.has(binding_group)) {
		pending.add(binding_group);

		queue_micro_task(() => {
			// necessary to maintain binding group order in all insertion scenarios
			binding_group.sort((a, b) => (a.compareDocumentPosition(b) === 4 ? -1 : 1));
			pending.delete(binding_group);
		});
	}

	queue_micro_task(() => {
		if (hydration_mismatch) {
			var value;

			if (is_checkbox) {
				value = get_binding_group_value(binding_group, value, input.checked);
			} else {
				var hydration_input = binding_group.find((input) => input.checked);
				value = hydration_input?.__value;
			}

			set(value);
		}
	});
}

export function bind_checked(
	input: HTMLInputElement,
	get: () => unknown,
	set: (value: unknown) => void = get
): void {
	listen_to_event(input, 'change', () => {
		set(input.checked);
	});

	if (
		// If we are hydrating and the value has since changed,
		// then use the update value from the input instead.
		(hydrating && input.defaultChecked !== input.checked) ||
		// If defaultChecked is set, then checked == defaultChecked
		untrack(get) == null
	) {
		set(input.checked);
	}

	render_effect(() => {
		var value = get();
		input.checked = Boolean(value);
	});
}

function get_binding_group_value<V>(group: Input[], __value: V, checked: boolean): V[] {
	var value = new Set<V>();

	for (var i = 0; i < group.length; i += 1) {
		if (group[i].checked) {
			value.add(group[i].__value as V);
		}
	}

	if (!checked) {
		value.delete(__value);
	}

	return Array.from(value);
}

function is_numberlike_input(input: HTMLInputElement): boolean {
	var type = input.type;
	return type === 'number' || type === 'range';
}

function to_number(value: string): number | null {
	return value === '' ? null : +value;
}

export function bind_files(
	input: HTMLInputElement,
	get: () => FileList | null,
	set: (value: FileList | null) => void = get
): void {
	listen_to_event(input, 'change', () => {
		set(input.files);
	});

	if (
		// If we are hydrating and the value has since changed,
		// then use the updated value from the input instead.
		hydrating &&
		input.files
	) {
		set(input.files);
	}

	render_effect(() => {
		input.files = get();
	});
}
