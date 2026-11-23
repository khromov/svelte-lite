import type { Source } from '../internal/client/types.ts';
import { DEV } from 'esm-env';
import { label, tag } from '../internal/client/dev/tracing.ts';
import { increment, set, source, state } from '../internal/client/reactivity/sources.ts';
import { get, update_version } from '../internal/client/runtime.ts';

/**
 * A reactive version of the built-in [`Map`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map) object.
 * Reading contents of the map (by iterating, or by reading `map.size` or calling `map.get(...)` or `map.has(...)` as in the [tic-tac-toe example](https://svelte.dev/playground/0b0ff4aa49c9443f9b47fe5203c78293) below) in an [effect](https://svelte.dev/docs/svelte/$effect) or [derived](https://svelte.dev/docs/svelte/$derived)
 * will cause it to be re-evaluated as necessary when the map is updated.
 *
 * Note that values in a reactive map are _not_ made [deeply reactive](https://svelte.dev/docs/svelte/$state#Deep-state).
 *
 * ```svelte
 * <script>
 * 	import { SvelteMap } from 'svelte/reactivity';
 * 	import { result } from './game.js';
 *
 * 	let board = new SvelteMap();
 * 	let player = $state('x');
 * 	let winner = $derived(result(board));
 *
 * 	function reset() {
 * 		player = 'x';
 * 		board.clear();
 * 	}
 * </script>
 *
 * <div class="board">
 * 	{#each Array(9), i}
 * 		<button
 * 			disabled={board.has(i) || winner}
 * 			onclick={() => {
 * 				board.set(i, player);
 * 				player = player === 'x' ? 'o' : 'x';
 * 			}}
 * 		>{board.get(i)}</button>
 * 	{/each}
 * </div>
 *
 * {#if winner}
 * 	<p>{winner} wins!</p>
 * 	<button onclick={reset}>reset</button>
 * {:else}
 * 	<p>{player} is next</p>
 * {/if}
 * ```
 */
export class SvelteMap<K, V> extends Map<K, V> {
	/** One per key that was read or set. It changes when the key gets another value or is deleted */
	#sources = new Map<K, Source<number>>();
	#version = state(0);
	#size = state(0);
	#update_version = update_version || -1;

	constructor(value?: Iterable<readonly [K, V]> | null | undefined) {
		super();

		if (DEV) {
			// If the value is invalid then the native exception will fire here
			value = new Map(value);

			tag(this.#version, 'SvelteMap version');
			tag(this.#size, 'SvelteMap.size');
		}

		if (value) {
			for (var [key, v] of value) {
				super.set(key, v);
			}
			this.#size.v = super.size;
		}
	}

	/**
	 * Creates the source of a key.
	 *
	 * If the source is being created inside the same reaction as the SvelteMap instance,
	 * we use `state` so that it will not be a dependency of the reaction. Otherwise we
	 * use `source` so it will be.
	 */
	#source(key: K): Source<number> {
		var s = update_version === this.#update_version ? state(0) : source(0);

		if (DEV) {
			tag(s, `SvelteMap get(${label(key)})`);
		}

		this.#sources.set(key, s);
		return s;
	}

	/** Makes the active reaction depend on `key`, and returns whether the map has it */
	#read(key: K) {
		var s = this.#sources.get(key);

		if (s === undefined) {
			if (!super.has(key)) {
				// We should always track the version in case
				// the Map ever gets this key in the future.
				get(this.#version);
				return false;
			}

			s = this.#source(key);
		}

		get(s);
		return true;
	}

	has(key: K) {
		return this.#read(key);
	}

	forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, this_arg?: any) {
		this.#read_all();
		super.forEach(callbackfn, this_arg);
	}

	get(key: K) {
		return this.#read(key) ? super.get(key) : undefined;
	}

	getOrInsert(key: K, value: V) {
		if (!super.has(key)) {
			this.set(key, value);
		}
		return this.get(key) as V;
	}

	getOrInsertComputed(key: K, callbackFn: (key: K) => V) {
		if (!super.has(key)) {
			this.set(key, callbackFn(key));
		}
		return this.get(key) as V;
	}

	set(key: K, value: V) {
		var s = this.#sources.get(key);
		var prev_res = super.get(key);
		var res = super.set(key, value);
		var version = this.#version;

		if (s === undefined) {
			this.#source(key);
			set(this.#size, super.size);
			increment(version);
		} else if (prev_res !== value) {
			increment(s);

			// if not every reaction of s is a reaction of version we need to also include version
			var v_reactions = version.reactions === null ? null : new Set(version.reactions);
			var needs_version_increase =
				v_reactions === null || !s.reactions?.every((r) => v_reactions!.has(r));
			if (needs_version_increase) {
				increment(version);
			}
		}

		return res;
	}

	delete(key: K) {
		var sources = this.#sources;
		var s = sources.get(key);
		var res = super.delete(key);

		if (s !== undefined) {
			sources.delete(key);
			set(s, -1);
		}

		if (res) {
			set(this.#size, super.size);
			increment(this.#version);
		}

		return res;
	}

	clear() {
		if (super.size === 0) {
			return;
		}
		// Clear first, so we get nice console.log outputs with $inspect
		super.clear();
		var sources = this.#sources;
		set(this.#size, 0);
		for (var s of sources.values()) {
			set(s, -1);
		}
		increment(this.#version);
		sources.clear();
	}

	#read_all() {
		get(this.#version);

		var sources = this.#sources;
		if (this.#size.v !== sources.size) {
			for (var key of super.keys()) {
				if (!sources.has(key)) {
					this.#source(key);
				}
			}
		}

		for (var s of sources.values()) {
			get(s);
		}
	}

	keys() {
		get(this.#version);
		return super.keys();
	}

	values() {
		this.#read_all();
		return super.values();
	}

	entries() {
		this.#read_all();
		return super.entries();
	}

	[Symbol.iterator]() {
		return this.entries();
	}

	get size() {
		get(this.#size);
		return super.size;
	}
}
