// Rune module (compiled with compileModule): shared state, classes with $state/$derived fields
// (public, private and constructor-declared), a closure-based store and createSubscriber.
import { createSubscriber } from 'svelte/reactivity';

export const shared = $state({ clicks: 0 });

let next_id = 1;

export class Todo {
	id = next_id++;
	done = $state(false);
	#edits = $state(0);

	constructor(text) {
		// $state declared in the constructor
		this.text = $state(text);
	}

	get edits() {
		return this.#edits;
	}

	rename(text) {
		this.text = text;
		this.#edits++;
	}
}

export class TodoList {
	items = $state([]);
	remaining = $derived(this.items.filter((t) => !t.done).length);

	constructor(texts) {
		this.items = texts.map((t) => new Todo(t));
	}

	add(text) {
		this.items.push(new Todo(text));
	}

	clearDone() {
		this.items = this.items.filter((t) => !t.done);
	}
}

export function createCounter(initial = 0) {
	let count = $state(initial);
	const double = $derived(count * 2);
	return {
		get count() {
			return count;
		},
		get double() {
			return double;
		},
		increment: () => count++
	};
}

/** An external event source made reactive with createSubscriber (subscribes only while read in an effect). */
export class Ticker {
	#target = new EventTarget();
	#value = 0;
	listeners = 0;
	#subscribe;

	constructor() {
		this.#subscribe = createSubscriber((update) => {
			this.listeners++;
			this.#target.addEventListener('tick', update);
			return () => {
				this.listeners--;
				this.#target.removeEventListener('tick', update);
			};
		});
	}

	get value() {
		this.#subscribe();
		return this.#value;
	}

	tick() {
		this.#value++;
		this.#target.dispatchEvent(new Event('tick'));
	}
}
