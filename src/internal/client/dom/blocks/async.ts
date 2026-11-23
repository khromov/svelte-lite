import { unsupported } from '../../../../unsupported.ts';

/**
 * Renders a part of a template once the `await` expressions in it have resolved. Only a
 * component compiled with `experimental.async` contains a call of this, so nothing is behind
 * it. The name stays for as long as `internal/client/index` re-exports it.
 */
export function async(): never {
	unsupported('`experimental.async` in the browser');
}
