import type { Source } from '../../types.ts';
import { LEGACY_PROPS } from '../../constants.ts';
import { effect_root, render_effect } from '../../reactivity/effects.ts';
import { safe_equals } from '../../reactivity/equality.ts';
import { set, source } from '../../reactivity/sources.ts';
import { mount, unmount } from '../../render.ts';
import { get } from '../../runtime.ts';
import { append } from '../template.ts';
import { define_property, get_descriptor, object_keys } from '../../../shared/utils.ts';
import { create_element } from '../operations.ts';

export interface CustomElementPropDefinition {
	attribute?: string;
	reflect?: boolean;
	type?: 'String' | 'Boolean' | 'Number' | 'Array' | 'Object';
}

type PropDefinitions = Record<string, CustomElementPropDefinition>;

let SvelteElement: any;

if (typeof HTMLElement === 'function') {
	SvelteElement = class extends HTMLElement {
		/** The Svelte component constructor */
		$$ctor: any;
		/** Slots */
		$$s: string[];
		/** The Svelte component instance */
		$$c: any;
		/** The props the component was mounted with, see `element_props` */
		$$v: Record<string | symbol, any> = {};
		/** Whether or not the custom element is connected */
		$$cn = false;
		/** Component props data */
		$$d: Record<string, any> = {};
		/** `true` if currently in the process of reflecting component props back to attributes */
		$$r = false;
		/** Props definition (name, reflected, type etc) */
		$$p_d: PropDefinitions = {};
		/** The managed render effect for reflecting attributes */
		$$me: any;
		/** The ShadowRoot of the custom element */
		$$shadowRoot: ShadowRoot | null = null;

		constructor(
			$$componentCtor: any,
			$$slots: string[],
			shadow_root_init: ShadowRootInit | undefined
		) {
			super();
			this.$$ctor = $$componentCtor;
			this.$$s = $$slots;

			if (shadow_root_init) {
				// We need to store the reference to shadow root, because `closed` shadow root cannot be
				// accessed with `this.shadowRoot`.
				this.$$shadowRoot = this.attachShadow(shadow_root_init);
			}
		}

		// The listeners of the element see the events that the component dispatches on it
		// (`$host().dispatchEvent(...)`). In Svelte they also get the component's own events,
		// those of `createEventDispatcher` and of forwarding (`<button on:click>`): svelte-lite
		// has neither, so `addEventListener` is the element's own

		async connectedCallback() {
			this.$$cn = true;
			if (!this.$$c) {
				// We wait one tick to let possible child slot elements be created/mounted
				await Promise.resolve();
				if (!this.$$cn || this.$$c) {
					return;
				}
				const $$slots: Record<string, any> = {};
				const existing_slots = get_custom_elements_slots(this);
				for (const name of this.$$s) {
					if (name in existing_slots) {
						if (name === 'default' && !this.$$d.children) {
							this.$$d.children = create_slot(name);
							$$slots.default = true;
						} else {
							$$slots[name] = create_slot(name);
						}
					}
				}
				for (const attribute of this.attributes) {
					// this.$$data takes precedence over this.attributes
					const name = this.$$g_p(attribute.name);
					if (!(name in this.$$d)) {
						this.$$d[name] = get_custom_element_value(name, attribute.value, this.$$p_d, 'toProp');
					}
				}
				// Port over props that were set programmatically before ce was initialized
				const own_props = this as Record<string, any>;
				for (const key in this.$$p_d) {
					if (!(key in this.$$d) && own_props[key] !== undefined) {
						this.$$d[key] = own_props[key]; // don't transform, these were set through JavaScript
						delete own_props[key]; // remove the property that shadows the getter/setter
					}
				}
				this.$$v = element_props({ ...this.$$d, $$slots, $$host: this });
				this.$$c = mount(this.$$ctor, {
					target: this.$$shadowRoot || this,
					props: this.$$v,
					intro: false
				});

				// Reflect component props as attributes
				this.$$me = effect_root(() => {
					render_effect(() => {
						this.$$r = true;
						for (const key of object_keys(this.$$c)) {
							if (!this.$$p_d[key]?.reflect) continue;
							this.$$d[key] = this.$$c[key];
							const attribute_value = get_custom_element_value(
								key,
								this.$$d[key],
								this.$$p_d,
								'toAttribute'
							);
							if (attribute_value == null) {
								this.removeAttribute(this.$$p_d[key].attribute || key);
							} else {
								this.setAttribute(this.$$p_d[key].attribute || key, attribute_value);
							}
						}
						this.$$r = false;
					});
				});
			}
		}

		// We don't need this when working within Svelte code, but for compatibility of people using this outside of Svelte
		// and setting attributes through setAttribute etc, this is helpful
		attributeChangedCallback(attr: string, _oldValue: string, newValue: string) {
			if (this.$$r) return;
			attr = this.$$g_p(attr);
			this.$$d[attr] = get_custom_element_value(attr, newValue, this.$$p_d, 'toProp');
			if (this.$$c) this.$$v[attr] = this.$$d[attr];
		}

		disconnectedCallback() {
			this.$$cn = false;
			// In a microtask, because this could be a move within the DOM
			Promise.resolve().then(() => {
				if (!this.$$cn && this.$$c) {
					unmount(this.$$c);
					this.$$me();
					this.$$c = undefined;
				}
			});
		}

		/** The name of the prop that an attribute stands for */
		$$g_p(attribute_name: string) {
			return (
				object_keys(this.$$p_d).find(
					(key) =>
						this.$$p_d[key].attribute === attribute_name ||
						(!this.$$p_d[key].attribute && key.toLowerCase() === attribute_name)
				) || attribute_name
			);
		}
	};
}

/**
 * The props of the component of a custom element. Each one is a signal of its own, created
 * when it is first read or set, and setting one to the object it already holds notifies,
 * because the object may have been mutated. Unlike a `$state` proxy, an object that is
 * passed in stays as it is. Custom elements were built on `createClassComponent` of
 * `svelte/legacy`, and this is the part of it that they need.
 */
function element_props(initial: Record<string | symbol, any>) {
	const sources = new Map<string | symbol, Source<any>>();

	const add_source = (key: string | symbol, value: unknown) => {
		const s = source(value);
		s.equals = safe_equals;
		sources.set(key, s);
		return s;
	};

	return new Proxy(initial, {
		get(target, prop) {
			return get(sources.get(prop) ?? add_source(prop, Reflect.get(target, prop)));
		},
		has(target, prop) {
			// the component writes a bound prop back to the props it was mounted with (see `prop`),
			// instead of treating it as a prop that its parent did not bind
			if (prop === LEGACY_PROPS) return true;

			get(sources.get(prop) ?? add_source(prop, Reflect.get(target, prop)));
			return Reflect.has(target, prop);
		},
		set(target, prop, value) {
			set(sources.get(prop) ?? add_source(prop, value), value);
			return Reflect.set(target, prop, value);
		}
	});
}

/** A snippet that renders the `<slot>` through which the element's light DOM children show */
function create_slot(name: string) {
	return (anchor: Element) => {
		const slot = create_element('slot') as HTMLSlotElement;
		if (name !== 'default') slot.name = name;

		append(anchor, slot);
	};
}

function get_custom_element_value(
	prop: string,
	value: any,
	props_definition: PropDefinitions,
	transform?: 'toAttribute' | 'toProp'
) {
	const type = props_definition[prop]?.type;
	value = type === 'Boolean' && typeof value !== 'boolean' ? value != null : value;
	if (!transform || !props_definition[prop]) {
		return value;
	} else if (transform === 'toAttribute') {
		switch (type) {
			case 'Object':
			case 'Array':
				return value == null ? null : JSON.stringify(value);
			case 'Boolean':
				return value ? '' : null;
			case 'Number':
				return value == null ? null : value;
			default:
				return value;
		}
	} else {
		switch (type) {
			case 'Object':
			case 'Array':
				return value && JSON.parse(value);
			case 'Boolean':
				return value; // conversion already handled above
			case 'Number':
				return value != null ? +value : value;
			default:
				return value;
		}
	}
}

function get_custom_elements_slots(element: HTMLElement) {
	const result: Record<string, true> = {};
	element.childNodes.forEach((node) => {
		result[(node as Element).slot || 'default'] = true;
	});
	return result;
}

/**
 * @internal
 *
 * Turn a Svelte component into a custom element.
 * @param Component  A Svelte component function
 * @param props_definition  The props to observe
 * @param slots  The slots to create
 * @param exports  Explicitly exported values, other than props
 * @param shadow_root_init  Options passed to shadow DOM constructor
 */
export function create_custom_element(
	Component: any,
	props_definition: PropDefinitions,
	slots: string[],
	exports: string[],
	shadow_root_init: ShadowRootInit | undefined,
	extend?: (ce: new () => HTMLElement) => new () => HTMLElement
) {
	let Class: any = class extends SvelteElement {
		constructor() {
			super(Component, slots, shadow_root_init);
			this.$$p_d = props_definition;
		}
		static get observedAttributes() {
			return object_keys(props_definition).map((key) =>
				(props_definition[key].attribute || key).toLowerCase()
			);
		}
	};
	object_keys(props_definition).forEach((prop) => {
		define_property(Class.prototype, prop, {
			get() {
				return this.$$c && prop in this.$$c ? this.$$c[prop] : this.$$d[prop];
			},
			set(value) {
				value = get_custom_element_value(prop, value, props_definition);
				this.$$d[prop] = value;
				var component = this.$$c;

				if (component) {
					// If the instance has an accessor, use that instead
					var setter = get_descriptor(component, prop)?.get;

					if (setter) {
						component[prop] = value;
					} else {
						this.$$v[prop] = value;
					}
				}
			}
		});
	});
	exports.forEach((property) => {
		define_property(Class.prototype, property, {
			get() {
				return this.$$c?.[property];
			}
		});
	});
	if (extend) {
		Class = extend(Class);
	}
	Component.element = Class;
	return Class;
}
