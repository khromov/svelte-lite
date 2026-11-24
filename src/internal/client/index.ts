// The contract with the compiler: a compiled component does
// `import * as $ from 'svelte/internal/client'` and calls these by name, so the names and
// signatures here are fixed by Svelte's compiler.
//
// What Svelte exports here and svelte-lite does not, is what the compiler only emits for a
// feature that is left out:
//
// - legacy mode: `init`, `bind_prop`, `mutable_source`, `mutate`, `legacy_pre_effect`,
//   `legacy_pre_effect_reset`, `legacy_rest_props`, `reactive_import`, `invalidate_inner_signals`,
//   `deep_read`, `deep_read_state`
// - `experimental.async`: `async`, `async_derived`, `run`, `run_after_blockers`, `save`, `unsave`,
//   `wait`, `for_await_track_reactivity_loss`
// - custom renderers: `renderer_snippet`, `validate_snippet_renderer`, `push_renderer`,
//   `pop_renderer`, `cross`, `is_crossing`
// - the deprecated `compatibility.componentApi: 4` option: `add_legacy_event_listener`,
//   `update_legacy_props` (it also imports `createClassComponent` from `svelte/legacy`)
// - deprecated syntax: the modifiers of `on:` (`once`, `preventDefault`, `self`,
//   `stopImmediatePropagation`, `stopPropagation`, `trusted`), event forwarding (`bubble_event`),
//   `let:` (`invalid_default_snippet`)
//
// A component that needs one of these fails where it is compiled, see `src/compiler/index.ts`:
// a deprecated option there, deprecated syntax in `check/index.ts`, which also rejects the
// deprecated syntax whose helpers are shared with what is not deprecated (`on:click` on an
// element is `event`, as `onclick` is when it is not delegated).
//
// Some of what stays looks like it belongs to those features and does not:
//
// - `track_reactivity_loss` wraps every `await` in a component that is compiled with `dev`,
//   also one in an event handler, and `assign_async` is `assign` for `object.x ??= await ...`
// - `eager` and `pending` are `$state.eager(...)` and `$effect.pending()`, which compile without
//   `experimental.async`
// - `slot` and `sanitize_slots` are `<slot>` and `$$slots`, which a custom element renders its
//   light DOM children with
// - `check_target` and `legacy_api` are the errors, in dev, for using a component as a class

export { createAttachmentKey as attachment } from '../../attachments/index.ts';
export { FILENAME, HMR, NAMESPACE_SVG } from '../../constants.ts';
export { push, pop, add_svelte_meta } from './context.ts';
export { assign, assign_async } from './dev/assign.ts';
export { cleanup_styles } from './dev/css.ts';
export { add_locations } from './dev/elements.ts';
export { hmr } from './dev/hmr.ts';
export { create_ownership_validator } from './dev/ownership.ts';
export { check_target, legacy_api } from './dev/legacy.ts';
export { trace, tag, tag_proxy } from './dev/tracing.ts';
export { inspect } from './dev/inspect.ts';
export { validate_snippet_args } from './dev/validation.ts';
export { await_block as await } from './dom/blocks/await.ts';
export { if_block as if } from './dom/blocks/if.ts';
export { key } from './dom/blocks/key.ts';
export { css_props } from './dom/blocks/css-props.ts';
export { index, each } from './dom/blocks/each.ts';
export { html } from './dom/blocks/html.ts';
export { sanitize_slots, slot } from './dom/blocks/slot.ts';
export { snippet, wrap_snippet } from './dom/blocks/snippet.ts';
export { component } from './dom/blocks/svelte-component.ts';
export { element } from './dom/blocks/svelte-element.ts';
export { head } from './dom/blocks/svelte-head.ts';
export { append_styles } from './dom/css.ts';
export { action } from './dom/elements/actions.ts';
export { attach } from './dom/elements/attachments.ts';
export {
	remove_input_defaults,
	set_attribute,
	attribute_effect,
	set_custom_element_data,
	set_xlink_attribute,
	set_value,
	set_checked,
	set_default_checked,
	set_default_value,
	CLASS,
	STYLE
} from './dom/elements/attributes.ts';
export { set_class } from './dom/elements/class.ts';
export { apply, event, delegated, delegate, replay_events } from './dom/elements/events.ts';
export { autofocus, remove_textarea_child } from './dom/elements/misc.ts';
export { customizable_select, selectedcontent } from './dom/elements/customizable-select.ts';
export { set_style } from './dom/elements/style.ts';
export { animation, transition } from './dom/elements/transitions.ts';
export { bind_active_element } from './dom/elements/bindings/document.ts';
export { bind_checked, bind_files, bind_group, bind_value } from './dom/elements/bindings/input.ts';
export {
	bind_buffered,
	bind_current_time,
	bind_ended,
	bind_muted,
	bind_paused,
	bind_playback_rate,
	bind_played,
	bind_ready_state,
	bind_seekable,
	bind_seeking,
	bind_volume
} from './dom/elements/bindings/media.ts';
export { bind_online } from './dom/elements/bindings/navigator.ts';
export {
	bind_select_value,
	init_select,
	select_option,
	set_selected,
	set_default_select_value
} from './dom/elements/bindings/select.ts';
export { bind_element_size, bind_resize_observer } from './dom/elements/bindings/size.ts';
export { bind_this } from './dom/elements/bindings/this.ts';
export {
	bind_content_editable,
	bind_property,
	bind_focused
} from './dom/elements/bindings/universal.ts';
export { bind_window_scroll, bind_window_size } from './dom/elements/bindings/window.ts';
export { hydrate_template, next, reset } from './dom/hydration.ts';
export {
	append,
	comment,
	from_html,
	from_mathml,
	from_svg,
	from_tree,
	text,
	props_id,
	with_script
} from './dom/template.ts';
export { track_reactivity_loss } from './reactivity/async.ts';
export { eager, flushSync as flush } from './reactivity/batch.ts';
export { user_derived as derived, derived_safe_equal } from './reactivity/deriveds.ts';
export {
	effect_tracking,
	effect_root,
	render_effect,
	template_effect,
	deferred_template_effect,
	effect,
	user_effect,
	user_pre_effect
} from './reactivity/effects.ts';
export { set, state, update, update_pre } from './reactivity/sources.ts';
export {
	prop,
	rest_props,
	spread_props,
	update_pre_prop,
	update_prop
} from './reactivity/props.ts';
export {
	invalidate_store,
	store_mutate,
	setup_stores,
	store_get,
	store_set,
	store_unsub,
	update_pre_store,
	update_store,
	mark_store_binding
} from './reactivity/store.ts';
export { boundary, pending } from './dom/blocks/boundary.ts';
export { set_text } from './render.ts';
export { get, safe_get, tick, untrack, active_effect } from './runtime.ts';
export { validate_binding } from './validate.ts';
export { raf } from './timing.ts';
export { proxy } from './proxy.ts';
export { create_custom_element } from './dom/elements/custom-element.ts';
export {
	child,
	only_child,
	first_child,
	get_last_child,
	sibling,
	$window as window,
	$document as document
} from './dom/operations.ts';
export { attr, clsx } from '../shared/attributes.ts';
export { snapshot } from '../shared/clone.ts';
export { noop, fallback, to_array, exclude_from_object } from '../shared/utils.ts';
export {
	validate_dynamic_element_tag,
	validate_store,
	validate_void_dynamic_element,
	prevent_snippet_stringification
} from '../shared/validate.ts';
export { strict_equals, equals } from './dev/equality.ts';
export { log_if_contains_state } from './dev/console-log.ts';
