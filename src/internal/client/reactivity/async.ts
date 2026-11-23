// This module is where Svelte keeps what `await` needs in a component: in its script, in its
// template and in `$derived`. All of that requires `experimental.async`, which svelte-lite
// leaves out, and the compiler refuses to compile for it. What remains is the one function
// that compiled output calls without it.

/**
 * In Svelte this notes which effect an `await` belongs to, so that a signal read after it,
 * which the effect does not track, can be warned about. Only an effect that `await`s with
 * `experimental.async` restores its context afterwards and can lose it in this way, so there is
 * nothing to note here. The compiler wraps every `await` of a component in this in dev mode
 */
export async function track_reactivity_loss<T>(promise: Promise<T>): Promise<() => T> {
	var value = await promise;

	return () => value;
}
