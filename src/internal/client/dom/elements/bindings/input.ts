import { DEV } from 'esm-env';
import { render_effect, teardown } from '../../../reactivity/effects.ts';
import { listen_to_event_and_reset_event } from './shared.ts';
import * as e from '../../../errors.ts';
import { is } from '../../../proxy.ts';
import { queue_micro_task } from '../../task.ts';
import { hydrating } from '../../hydration.ts';
import { tick, untrack } from '../../../runtime.ts';

/** `__value` is where compiled code and attribute spreading keep the `value` of an input, as it was given */
type Input = HTMLInputElement & { __value?: unknown };

export function bind_value(
	input: HTMLInputElement,
	get: () => unknown,
	set: (value: unknown) => void = get
): void {
	listen_to_event_and_reset_event(input, 'input', async (is_reset) => {
		if (DEV && input.type === 'checkbox') {
			// TODO should this happen in prod too?
			e.bind_invalid_checkbox_value();
		}

		var value: any = is_reset ? input.defaultValue : input.value;
		value = is_numberlike_input(input) ? to_number(value) : value;
		set(value);

		// Because `{#each ...}` blocks work by updating sources inside the flush,
		// we need to wait a tick before checking to see if we should forcibly
		// update the input and reset the selection state
		await tick();

		// Respect any validation in accessors
		if (value !== (value = get())) {
			var start = input.selectionStart;
			var end = input.selectionEnd;
			var length = input.value.length;

			// the value is coerced on assignment
			input.value = value ?? '';

			// Restore selection
			if (end !== null) {
				var new_length = input.value.length;
				// If cursor was at end and new input is longer, move cursor to new end
				if (start === end && end === length && new_length > length) {
					input.selectionStart = new_length;
					input.selectionEnd = new_length;
				} else {
					input.selectionStart = start;
					input.selectionEnd = Math.min(end, new_length);
				}
			}
		}
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
		// typed. That is left out with async. One thing differs because of it: a value that
		// the setter coerced is written below, before the handler above gets to restore the
		// selection around it, so the caret ends up at the end of the input

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

	listen_to_event_and_reset_event(
		input,
		'change',
		() => {
			var value = input.__value;

			if (is_checkbox) {
				value = get_binding_group_value(binding_group, value, input.checked);
			}

			set(value);
		},
		// TODO better default value handling
		() => set(is_checkbox ? [] : null)
	);

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
	listen_to_event_and_reset_event(input, 'change', (is_reset) => {
		var value = is_reset ? input.defaultChecked : input.checked;
		set(value);
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
	listen_to_event_and_reset_event(
		input,
		'change',
		() => {
			set(input.files);
		},
		() => {
			// A form reset can empty the input's `FileList` in place, which is then the very
			// object the binding already holds and would not be seen as a change: give the
			// input a new, empty one instead
			if (typeof DataTransfer === 'function') {
				input.files = new DataTransfer().files;
			}

			set(input.files);
		}
	);

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
