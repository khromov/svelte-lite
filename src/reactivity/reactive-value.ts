import { createSubscriber } from './create-subscriber.ts';

export class ReactiveValue<T> {
	#fn: () => T;
	#subscribe: () => void;

	constructor(fn: () => T, onsubscribe: (update: () => void) => void) {
		this.#fn = fn;
		this.#subscribe = createSubscriber(onsubscribe);
	}

	get current() {
		this.#subscribe();
		return this.#fn();
	}
}
