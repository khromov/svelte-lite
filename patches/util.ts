/**
 * `code\`...\`` turns a pasted code snippet into a RegExp that matches it with any
 * whitespace between tokens (indentation/line breaks don't matter, everything else is
 * literal). Patches anchor on real code this way instead of on line numbers.
 */
export function code(strings: TemplateStringsArray, ...values: unknown[]): RegExp {
	const raw = String.raw({ raw: strings }, ...values).trim();
	return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
}

/** Error thrown by stubs for features svelte-lite removed. */
export const unsupported = (what: string) =>
	`throw new Error(${JSON.stringify(`svelte-lite: ${what} is not supported in this build`)})`;
