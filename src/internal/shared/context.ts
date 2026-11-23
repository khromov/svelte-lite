import { lifecycle_outside_component, missing_context } from './errors.ts';

export function create_context<T>(
	get_context: (key: object) => T,
	set_context: (key: object, context: T) => T,
	has_context: (key: object) => boolean
): [() => T, (context: T) => T, () => boolean] {
	const key = {};

	return [
		() => {
			if (!has_context(key)) {
				missing_context();
			}

			return get_context(key);
		},
		(context) => set_context(key, context),
		() => has_context(key)
	];
}

/** What a component context of the client and one of the server have in common */
export type Context = { p: Context | null; c: Map<unknown, unknown> | null };

function get_parent_context(context: Context): Map<unknown, unknown> | null {
	let parent = context.p;
	while (parent !== null && parent.c === null) {
		parent = parent.p;
	}
	return parent?.c ?? null;
}

export function get_or_init_context_map(
	context: Context | null,
	name: string
): Map<unknown, unknown> {
	if (context === null) {
		lifecycle_outside_component(name);
	}

	return (context.c ??= new Map(get_parent_context(context) || undefined));
}
