// The errors of the client runtime. Svelte generates this module from `messages/client-errors`
// with `scripts/process-messages`. This is that output with types added, and it has to stay
// that: tests compare the texts, and the links lead to Svelte's documentation of each code.
// Every error is here, including those of features that svelte-lite leaves out: the modules
// borrowed from Svelte import them by name.

import { DEV } from 'esm-env';

export * from '../shared/errors.ts';

/**
 * Can only create a `$derived(...)` with an `await` expression during component initialization or in a declaration tag
 */
export function async_derived_orphan(): never {
	if (DEV) {
		const error = new Error(`async_derived_orphan\nCan only create a \`$derived(...)\` with an \`await\` expression during component initialization or in a declaration tag\nhttps://svelte.dev/e/async_derived_orphan`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/async_derived_orphan`);
	}
}

/**
 * Using `bind:value` together with a checkbox input is not allowed. Use `bind:checked` instead
 */
export function bind_invalid_checkbox_value(): never {
	if (DEV) {
		const error = new Error(`bind_invalid_checkbox_value\nUsing \`bind:value\` together with a checkbox input is not allowed. Use \`bind:checked\` instead\nhttps://svelte.dev/e/bind_invalid_checkbox_value`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/bind_invalid_checkbox_value`);
	}
}

/**
 * Component %component% has an export named `%key%` that a consumer component is trying to access using `bind:%key%`, which is disallowed. Instead, use `bind:this` (e.g. `<%name% bind:this={component} />`) and then access the property on the bound component instance (e.g. `component.%key%`)
 */
export function bind_invalid_export(component: string, key: string, name: string): never {
	if (DEV) {
		const error = new Error(`bind_invalid_export\nComponent ${component} has an export named \`${key}\` that a consumer component is trying to access using \`bind:${key}\`, which is disallowed. Instead, use \`bind:this\` (e.g. \`<${name} bind:this={component} />\`) and then access the property on the bound component instance (e.g. \`component.${key}\`)\nhttps://svelte.dev/e/bind_invalid_export`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/bind_invalid_export`);
	}
}

/**
 * A component is attempting to bind to a non-bindable property `%key%` belonging to %component% (i.e. `<%name% bind:%key%={...}>`). To mark a property as bindable: `let { %key% = $bindable() } = $props()`
 */
export function bind_not_bindable(key: string, component: string, name: string): never {
	if (DEV) {
		const error = new Error(`bind_not_bindable\nA component is attempting to bind to a non-bindable property \`${key}\` belonging to ${component} (i.e. \`<${name} bind:${key}={...}>\`). To mark a property as bindable: \`let { ${key} = $bindable() } = $props()\`\nhttps://svelte.dev/e/bind_not_bindable`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/bind_not_bindable`);
	}
}

/**
 * Calling `%method%` on a component instance (of %component%) is no longer valid in Svelte 5
 */
export function component_api_changed(method: string, component: string): never {
	if (DEV) {
		const error = new Error(`component_api_changed\nCalling \`${method}\` on a component instance (of ${component}) is no longer valid in Svelte 5\nhttps://svelte.dev/e/component_api_changed`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/component_api_changed`);
	}
}

/**
 * Attempted to instantiate %component% with `new %name%`, which is no longer valid in Svelte 5. If this component is not under your control, set the `compatibility.componentApi` compiler option to `4` to keep it working.
 */
export function component_api_invalid_new(component: string, name: string): never {
	if (DEV) {
		const error = new Error(`component_api_invalid_new\nAttempted to instantiate ${component} with \`new ${name}\`, which is no longer valid in Svelte 5. If this component is not under your control, set the \`compatibility.componentApi\` compiler option to \`4\` to keep it working.\nhttps://svelte.dev/e/component_api_invalid_new`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/component_api_invalid_new`);
	}
}

/**
 * `%operation%` is not supported when rendering with a custom renderer
 */
export function custom_renderer_unsupported_operation(operation: string): never {
	if (DEV) {
		const error = new Error(`custom_renderer_unsupported_operation\n\`${operation}\` is not supported when rendering with a custom renderer\nhttps://svelte.dev/e/custom_renderer_unsupported_operation`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/custom_renderer_unsupported_operation`);
	}
}

/**
 * A derived value cannot reference itself recursively
 */
export function derived_references_self(): never {
	if (DEV) {
		const error = new Error(`derived_references_self\nA derived value cannot reference itself recursively\nhttps://svelte.dev/e/derived_references_self`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/derived_references_self`);
	}
}

/**
 * Keyed each block has duplicate key `%value%` at indexes %a% and %b%
 */
export function each_key_duplicate(a: string, b: string, value?: string | null): never {
	if (DEV) {
		const error = new Error(`each_key_duplicate\n${value
			? `Keyed each block has duplicate key \`${value}\` at indexes ${a} and ${b}`
			: `Keyed each block has duplicate key at indexes ${a} and ${b}`}\nhttps://svelte.dev/e/each_key_duplicate`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/each_key_duplicate`);
	}
}

/**
 * Keyed each block has key that is not idempotent — the key for item at index %index% was `%a%` but is now `%b%`. Keys must be the same each time for a given item
 */
export function each_key_volatile(index: string, a: string, b: string): never {
	if (DEV) {
		const error = new Error(`each_key_volatile\nKeyed each block has key that is not idempotent — the key for item at index ${index} was \`${a}\` but is now \`${b}\`. Keys must be the same each time for a given item\nhttps://svelte.dev/e/each_key_volatile`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/each_key_volatile`);
	}
}

/**
 * `%rune%` cannot be used inside an effect cleanup function
 */
export function effect_in_teardown(rune: string): never {
	if (DEV) {
		const error = new Error(`effect_in_teardown\n\`${rune}\` cannot be used inside an effect cleanup function\nhttps://svelte.dev/e/effect_in_teardown`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/effect_in_teardown`);
	}
}

/**
 * Effect cannot be created inside a `$derived` value that was not itself created inside an effect
 */
export function effect_in_unowned_derived(): never {
	if (DEV) {
		const error = new Error(`effect_in_unowned_derived\nEffect cannot be created inside a \`$derived\` value that was not itself created inside an effect\nhttps://svelte.dev/e/effect_in_unowned_derived`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/effect_in_unowned_derived`);
	}
}

/**
 * `%rune%` can only be used inside an effect (e.g. during component initialisation)
 */
export function effect_orphan(rune: string): never {
	if (DEV) {
		const error = new Error(`effect_orphan\n\`${rune}\` can only be used inside an effect (e.g. during component initialisation)\nhttps://svelte.dev/e/effect_orphan`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/effect_orphan`);
	}
}

/**
 * `$effect.pending()` can only be called inside an effect or derived
 */
export function effect_pending_outside_reaction(): never {
	if (DEV) {
		const error = new Error(`effect_pending_outside_reaction\n\`$effect.pending()\` can only be called inside an effect or derived\nhttps://svelte.dev/e/effect_pending_outside_reaction`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/effect_pending_outside_reaction`);
	}
}

/**
 * Maximum update depth exceeded. This typically indicates that an effect reads and writes the same piece of state
 */
export function effect_update_depth_exceeded(): never {
	if (DEV) {
		const error = new Error(`effect_update_depth_exceeded\nMaximum update depth exceeded. This typically indicates that an effect reads and writes the same piece of state\nhttps://svelte.dev/e/effect_update_depth_exceeded`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/effect_update_depth_exceeded`);
	}
}

/**
 * Cannot use `flushSync` inside an effect
 */
export function flush_sync_in_effect(): never {
	if (DEV) {
		const error = new Error(`flush_sync_in_effect\nCannot use \`flushSync\` inside an effect\nhttps://svelte.dev/e/flush_sync_in_effect`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/flush_sync_in_effect`);
	}
}

/**
 * Cannot commit a fork that was already discarded
 */
export function fork_discarded(): never {
	if (DEV) {
		const error = new Error(`fork_discarded\nCannot commit a fork that was already discarded\nhttps://svelte.dev/e/fork_discarded`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/fork_discarded`);
	}
}

/**
 * Cannot create a fork inside an effect or when state changes are pending
 */
export function fork_timing(): never {
	if (DEV) {
		const error = new Error(`fork_timing\nCannot create a fork inside an effect or when state changes are pending\nhttps://svelte.dev/e/fork_timing`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/fork_timing`);
	}
}

/**
 * `getAbortSignal()` cannot be called after an `await`
 */
export function get_abort_signal_after_await(): never {
	if (DEV) {
		const error = new Error(`get_abort_signal_after_await\n\`getAbortSignal()\` cannot be called after an \`await\`\nhttps://svelte.dev/e/get_abort_signal_after_await`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/get_abort_signal_after_await`);
	}
}

/**
 * `getAbortSignal()` can only be called inside an effect or derived
 */
export function get_abort_signal_outside_reaction(): never {
	if (DEV) {
		const error = new Error(`get_abort_signal_outside_reaction\n\`getAbortSignal()\` can only be called inside an effect or derived\nhttps://svelte.dev/e/get_abort_signal_outside_reaction`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/get_abort_signal_outside_reaction`);
	}
}

/**
 * Expected to find a hydratable with key `%key%` during hydration, but did not.
 */
export function hydratable_missing_but_required(key: string): never {
	if (DEV) {
		const error = new Error(`hydratable_missing_but_required\nExpected to find a hydratable with key \`${key}\` during hydration, but did not.\nhttps://svelte.dev/e/hydratable_missing_but_required`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/hydratable_missing_but_required`);
	}
}

/**
 * Failed to hydrate the application
 */
export function hydration_failed(): never {
	if (DEV) {
		const error = new Error(`hydration_failed\nFailed to hydrate the application\nhttps://svelte.dev/e/hydration_failed`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/hydration_failed`);
	}
}

/**
 * Could not `{@render}` snippet due to the expression being `null` or `undefined`. Consider using optional chaining `{@render snippet?.()}`
 */
export function invalid_snippet(): never {
	if (DEV) {
		const error = new Error(`invalid_snippet\nCould not \`{@render}\` snippet due to the expression being \`null\` or \`undefined\`. Consider using optional chaining \`{@render snippet?.()}\`\nhttps://svelte.dev/e/invalid_snippet`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/invalid_snippet`);
	}
}

/**
 * `createRawSnippet` cannot be used with a custom renderer
 */
export function invalid_snippet_in_custom_renderer(): never {
	if (DEV) {
		const error = new Error(`invalid_snippet_in_custom_renderer\n\`createRawSnippet\` cannot be used with a custom renderer\nhttps://svelte.dev/e/invalid_snippet_in_custom_renderer`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/invalid_snippet_in_custom_renderer`);
	}
}

/**
 * `%name%(...)` cannot be used in runes mode
 */
export function lifecycle_legacy_only(name: string): never {
	if (DEV) {
		const error = new Error(`lifecycle_legacy_only\n\`${name}(...)\` cannot be used in runes mode\nhttps://svelte.dev/e/lifecycle_legacy_only`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/lifecycle_legacy_only`);
	}
}

/**
 * Cannot do `bind:%key%={undefined}` when `%key%` has a fallback value
 */
export function props_invalid_value(key: string): never {
	if (DEV) {
		const error = new Error(`props_invalid_value\nCannot do \`bind:${key}={undefined}\` when \`${key}\` has a fallback value\nhttps://svelte.dev/e/props_invalid_value`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/props_invalid_value`);
	}
}

/**
 * Rest element properties of `$props()` such as `%property%` are readonly
 */
export function props_rest_readonly(property: string): never {
	if (DEV) {
		const error = new Error(`props_rest_readonly\nRest element properties of \`$props()\` such as \`${property}\` are readonly\nhttps://svelte.dev/e/props_rest_readonly`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/props_rest_readonly`);
	}
}

/**
 * Cannot render content belonging to %guest% inside %host%. A custom renderer must define `embed` or `host` to be combined with another renderer
 */
export function renderer_cannot_cross(guest: string, host: string): never {
	if (DEV) {
		const error = new Error(`renderer_cannot_cross\nCannot render content belonging to ${guest} inside ${host}. A custom renderer must define \`embed\` or \`host\` to be combined with another renderer\nhttps://svelte.dev/e/renderer_cannot_cross`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/renderer_cannot_cross`);
	}
}

/**
 * The `%rune%` rune is only available inside `.svelte` and `.svelte.js/ts` files
 */
export function rune_outside_svelte(rune: string): never {
	if (DEV) {
		const error = new Error(`rune_outside_svelte\nThe \`${rune}\` rune is only available inside \`.svelte\` and \`.svelte.js/ts\` files\nhttps://svelte.dev/e/rune_outside_svelte`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/rune_outside_svelte`);
	}
}

/**
 * A snippet created in a component that was compiled without `experimental.customRenderer` cannot be rendered by a custom renderer
 */
export function snippet_renderer_mismatch(): never {
	if (DEV) {
		const error = new Error(`snippet_renderer_mismatch\nA snippet created in a component that was compiled without \`experimental.customRenderer\` cannot be rendered by a custom renderer\nhttps://svelte.dev/e/snippet_renderer_mismatch`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/snippet_renderer_mismatch`);
	}
}

/**
 * Property descriptors defined on `$state` objects must contain `value` and always be `enumerable`, `configurable` and `writable`.
 */
export function state_descriptors_fixed(): never {
	if (DEV) {
		const error = new Error(`state_descriptors_fixed\nProperty descriptors defined on \`$state\` objects must contain \`value\` and always be \`enumerable\`, \`configurable\` and \`writable\`.\nhttps://svelte.dev/e/state_descriptors_fixed`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/state_descriptors_fixed`);
	}
}

/**
 * Cannot set prototype of `$state` object
 */
export function state_prototype_fixed(): never {
	if (DEV) {
		const error = new Error(`state_prototype_fixed\nCannot set prototype of \`$state\` object\nhttps://svelte.dev/e/state_prototype_fixed`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/state_prototype_fixed`);
	}
}

/**
 * Updating state inside `$derived(...)`, `$inspect(...)` or a template expression is forbidden. If the value should not be reactive, declare it without `$state`
 */
export function state_unsafe_mutation(): never {
	if (DEV) {
		const error = new Error(`state_unsafe_mutation\nUpdating state inside \`$derived(...)\`, \`$inspect(...)\` or a template expression is forbidden. If the value should not be reactive, declare it without \`$state\`\nhttps://svelte.dev/e/state_unsafe_mutation`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/state_unsafe_mutation`);
	}
}

/**
 * A `<svelte:boundary>` `reset` function cannot be called while an error is still being handled
 */
export function svelte_boundary_reset_onerror(): never {
	if (DEV) {
		const error = new Error(`svelte_boundary_reset_onerror\nA \`<svelte:boundary>\` \`reset\` function cannot be called while an error is still being handled\nhttps://svelte.dev/e/svelte_boundary_reset_onerror`);

		error.name = 'Svelte error';

		throw error;
	} else {
		throw new Error(`https://svelte.dev/e/svelte_boundary_reset_onerror`);
	}
}