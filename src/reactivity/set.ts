import type { Source } from '../internal/client/types.ts';
import { DEV } from 'esm-env';
import { label, tag } from '../internal/client/dev/tracing.ts';
import { increment, set, source, state } from '../internal/client/reactivity/sources.ts';
import { get, update_version } from '../internal/client/runtime.ts';

var read_methods = ['forEach', 'isDisjointFrom', 'isSubsetOf', 'isSupersetOf'];
var set_like_methods = ['difference', 'intersection', 'symmetricDifference', 'union'];

var inited = false;

/**
 * A reactive version of the built-in [`Set`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set) object.
 * Reading contents of the set (by iterating, or by reading `set.size` or calling `set.has(...)` as in the [example](https://svelte.dev/playground/53438b51194b4882bcc18cddf9f96f15) below) in an [effect](https://svelte.dev/docs/svelte/$effect) or [derived](https://svelte.dev/docs/svelte/$derived)
 * will cause it to be re-evaluated as necessary when the set is updated.
 *
 * Note that values in a reactive set are _not_ made [deeply reactive](https://svelte.dev/docs/svelte/$state#Deep-state).
 *
 * ```svelte
 * <script>
 * 	import { SvelteSet } from 'svelte/reactivity';
 * 	let monkeys = new SvelteSet();
 *
 * 	function toggle(monkey) {
 * 		if (monkeys.has(monkey)) {
 * 			monkeys.delete(monkey);
 * 		} else {
 * 			monkeys.add(monkey);
 * 		}
 * 	}
 * </script>
 *
 * {#each ['🙈', '🙉', '🙊'] as monkey}
 * 	<button onclick={() => toggle(monkey)}>{monkey}</button>
 * {/each}
 *
 * <button onclick={() => monkeys.clear()}>clear</button>
 *
 * {#if monkeys.has('🙈')}<p>see no evil</p>{/if}
 * {#if monkeys.has('🙉')}<p>hear no evil</p>{/if}
 * {#if monkeys.has('🙊')}<p>speak no evil</p>{/if}
 * ```
 */
export class SvelteSet<T> extends Set<T> {
	/** One per value that `has` found in the set. It becomes `false` when the value is deleted */
	#sources = new Map<T, Source<boolean>>();
	#version = state(0);
	#size = state(0);
	#update_version = update_version || -1;

	constructor(value?: Iterable<T> | null | undefined) {
		super();

		if (DEV) {
			// If the value is invalid then the native exception will fire here
			value = new Set(value);

			tag(this.#version, 'SvelteSet version');
			tag(this.#size, 'SvelteSet.size');
		}

		if (value) {
			for (var element of value) {
				super.add(element);
			}
			this.#size.v = super.size;
		}

		if (!inited) this.#init();
	}

	// We init as part of the first instance so that we can treeshake this class
	#init() {
		inited = true;

		var proto = SvelteSet.prototype as any;
		var set_proto = Set.prototype as any;

		for (const method of read_methods) {
			proto[method] = function (this: SvelteSet<any>, ...v: any[]) {
				get(this.#version);
				return set_proto[method].apply(this, v);
			};
		}

		for (const method of set_like_methods) {
			proto[method] = function (this: SvelteSet<any>, ...v: any[]) {
				get(this.#version);
				var set: Set<any> = set_proto[method].apply(this, v);
				return new SvelteSet(set);
			};
		}
	}

	has(value: T) {
		var has = super.has(value);
		var sources = this.#sources;
		var s = sources.get(value);

		if (s === undefined) {
			if (!has) {
				// If the value doesn't exist, track the version in case it's added later
				// but don't create sources willy-nilly to track all possible values
				get(this.#version);
				return false;
			}

			// If the source is being created inside the same reaction as the SvelteSet instance,
			// we use `state` so that it will not be a dependency of the reaction. Otherwise we
			// use `source` so it will be.
			s = update_version === this.#update_version ? state(true) : source(true);

			if (DEV) {
				tag(s, `SvelteSet has(${label(value)})`);
			}

			sources.set(value, s);
		}

		get(s);
		return has;
	}

	add(value: T) {
		if (!super.has(value)) {
			super.add(value);
			set(this.#size, super.size);
			increment(this.#version);
		}

		return this;
	}

	delete(value: T) {
		var deleted = super.delete(value);
		var sources = this.#sources;
		var s = sources.get(value);

		if (s !== undefined) {
			sources.delete(value);
			set(s, false);
		}

		if (deleted) {
			set(this.#size, super.size);
			increment(this.#version);
		}

		return deleted;
	}

	clear() {
		if (super.size === 0) {
			return;
		}
		// Clear first, so we get nice console.log outputs with $inspect
		super.clear();
		var sources = this.#sources;

		for (var s of sources.values()) {
			set(s, false);
		}

		sources.clear();
		set(this.#size, 0);
		increment(this.#version);
	}

	keys() {
		return this.values();
	}

	values() {
		get(this.#version);
		return super.values();
	}

	entries() {
		get(this.#version);
		return super.entries();
	}

	[Symbol.iterator]() {
		return this.keys();
	}

	get size() {
		return get(this.#size);
	}
}
