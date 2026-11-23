import { is_void } from '../../utils.ts';
import * as w from './warnings.ts';
import * as e from './errors.ts';

export { invalid_default_snippet } from './errors.ts';

export function validate_void_dynamic_element(tag_fn: () => string): void {
	const tag = tag_fn();
	if (tag && is_void(tag)) {
		w.dynamic_void_element_content(tag);
	}
}

export function validate_dynamic_element_tag(tag_fn: () => unknown) {
	const tag = tag_fn();
	const is_string = typeof tag === 'string';
	if (tag && !is_string) {
		e.svelte_element_invalid_this_value();
	}
}

export function validate_store(store: any, name: string) {
	if (store != null && typeof store.subscribe !== 'function') {
		e.store_invalid_shape(name);
	}
}

export function prevent_snippet_stringification<T extends (...args: any[]) => unknown>(fn: T) {
	fn.toString = () => {
		e.snippet_without_render_tag();
		return '';
	};
	return fn;
}
