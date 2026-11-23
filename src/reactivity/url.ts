import { DEV } from 'esm-env';
import { tag } from '../internal/client/dev/tracing.ts';
import { set, state } from '../internal/client/reactivity/sources.ts';
import { get } from '../internal/client/runtime.ts';
import { REPLACE, SvelteURLSearchParams } from './url-search-params.ts';

/** The URL whose `searchParams` are being created, which is how they find the URL they belong to */
let current_url: SvelteURL | null = null;

export function get_current_url() {
	// ideally we'd just export `current_url` directly, but it seems Vitest doesn't respect live bindings
	return current_url;
}

/**
 * A reactive version of the built-in [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL) object.
 * Reading properties of the URL (such as `url.href` or `url.pathname`) in an [effect](https://svelte.dev/docs/svelte/$effect) or [derived](https://svelte.dev/docs/svelte/$derived)
 * will cause it to be re-evaluated as necessary when the URL changes.
 *
 * The `searchParams` property is an instance of [SvelteURLSearchParams](https://svelte.dev/docs/svelte/svelte-reactivity#SvelteURLSearchParams).
 *
 * [Example](https://svelte.dev/playground/5a694758901b448c83dc40dc31c71f2a):
 *
 * ```svelte
 * <script>
 * 	import { SvelteURL } from 'svelte/reactivity';
 *
 * 	const url = new SvelteURL('https://example.com/path');
 * </script>
 *
 * <!-- changes to these... -->
 * <input bind:value={url.protocol} />
 * <input bind:value={url.hostname} />
 * <input bind:value={url.pathname} />
 *
 * <hr />
 *
 * <!-- will update `href` and vice versa -->
 * <input bind:value={url.href} size="65" />
 * ```
 */
export class SvelteURL extends URL {
	#protocol = state(super.protocol);
	#username = state(super.username);
	#password = state(super.password);
	#hostname = state(super.hostname);
	#port = state(super.port);
	#pathname = state(super.pathname);
	#hash = state(super.hash);
	#search = state(super.search);
	#searchParams: SvelteURLSearchParams;

	constructor(url: string | URL, base?: string | URL) {
		url = new URL(url, base);
		super(url);

		if (DEV) {
			tag(this.#protocol, 'SvelteURL.protocol');
			tag(this.#username, 'SvelteURL.username');
			tag(this.#password, 'SvelteURL.password');
			tag(this.#hostname, 'SvelteURL.hostname');
			tag(this.#port, 'SvelteURL.port');
			tag(this.#pathname, 'SvelteURL.pathname');
			tag(this.#hash, 'SvelteURL.hash');
			tag(this.#search, 'SvelteURL.search');
		}

		current_url = this;
		this.#searchParams = new SvelteURLSearchParams(url.searchParams);
		current_url = null;
	}

	get hash() {
		return get(this.#hash);
	}

	set hash(value: string) {
		super.hash = value;
		set(this.#hash, super.hash);
	}

	get host() {
		get(this.#hostname);
		get(this.#port);
		return super.host;
	}

	set host(value: string) {
		super.host = value;
		set(this.#hostname, super.hostname);
		set(this.#port, super.port);
	}

	get hostname() {
		return get(this.#hostname);
	}

	set hostname(value: string) {
		super.hostname = value;
		set(this.#hostname, super.hostname);
	}

	get href() {
		get(this.#protocol);
		get(this.#username);
		get(this.#password);
		get(this.#hostname);
		get(this.#port);
		get(this.#pathname);
		get(this.#hash);
		get(this.#search);
		return super.href;
	}

	set href(value: string) {
		super.href = value;
		set(this.#protocol, super.protocol);
		set(this.#username, super.username);
		set(this.#password, super.password);
		set(this.#hostname, super.hostname);
		set(this.#port, super.port);
		set(this.#pathname, super.pathname);
		set(this.#hash, super.hash);
		set(this.#search, super.search);
		this.#searchParams[REPLACE](super.searchParams);
	}

	get password() {
		return get(this.#password);
	}

	set password(value: string) {
		super.password = value;
		set(this.#password, super.password);
	}

	get pathname() {
		return get(this.#pathname);
	}

	set pathname(value: string) {
		super.pathname = value;
		set(this.#pathname, super.pathname);
	}

	get port() {
		return get(this.#port);
	}

	set port(value: string) {
		super.port = value;
		set(this.#port, super.port);
	}

	get protocol() {
		return get(this.#protocol);
	}

	set protocol(value: string) {
		super.protocol = value;
		set(this.#protocol, super.protocol);
		// changing the protocol can clear the port when it matches the new scheme's default
		set(this.#port, super.port);
	}

	get search() {
		return get(this.#search);
	}

	set search(value: string) {
		super.search = value;
		set(this.#search, super.search);
		this.#searchParams[REPLACE](super.searchParams);
	}

	get username() {
		return get(this.#username);
	}

	set username(value: string) {
		super.username = value;
		set(this.#username, super.username);
	}

	get origin() {
		get(this.#protocol);
		get(this.#hostname);
		get(this.#port);
		return super.origin;
	}

	get searchParams() {
		return this.#searchParams;
	}

	toString() {
		return this.href;
	}

	toJSON() {
		return this.href;
	}
}
