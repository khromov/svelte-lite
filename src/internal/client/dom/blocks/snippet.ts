import type { Snippet } from '../../../../index.ts';
import type { Getters } from '../../../shared/types.ts';
import type { TemplateNode } from '../../types.ts';
import { DEV } from 'esm-env';
import { unsupported } from '../../../../unsupported.ts';
import { prevent_snippet_stringification } from '../../../shared/validate.ts';
import { EFFECT_TRANSPARENT, ELEMENT_NODE } from '../../constants.ts';
import {
	component_context,
	dev_current_component_function,
	dev_stack,
	set_dev_current_component_function
} from '../../context.ts';
import * as e from '../../errors.ts';
import { block, teardown } from '../../reactivity/effects.ts';
import * as w from '../../warnings.ts';
import { hydrate_next, hydrate_node, hydrating } from '../hydration.ts';
import { get_first_child, get_next_sibling } from '../operations.ts';
import { create_fragment_from_html } from '../reconciler.ts';
import { assign_nodes } from '../template.ts';
import { BranchManager } from './branches.ts';

export function snippet<SnippetFn extends (node: TemplateNode, ...args: any[]) => void>(
	node: TemplateNode,
	get_snippet: () => SnippetFn | null | undefined,
	...args: (() => any)[]
): void {
	var branches = new BranchManager<SnippetFn | null>(node);

	block(() => {
		const snippet = get_snippet() ?? null;

		if (DEV && snippet == null) {
			e.invalid_snippet();
		}

		branches.ensure(snippet, snippet && ((anchor) => snippet(anchor, ...args)));
	}, EFFECT_TRANSPARENT);
}

/**
 * In development, wrap the snippet function so that it passes validation, and so that the
 * correct component context is set for ownership checks
 */
export function wrap_snippet(component: any, fn: (node: TemplateNode, ...args: any[]) => void) {
	const snippet = (node: TemplateNode, ...args: any[]) => {
		var previous_component_function = dev_current_component_function;
		set_dev_current_component_function(component);

		try {
			return fn(node, ...args);
		} finally {
			set_dev_current_component_function(previous_component_function);
		}
	};

	prevent_snippet_stringification(snippet);

	return snippet;
}

/**
 * Only the output of `experimental.customRenderer` calls this, and svelte-lite refuses to compile
 * with that option. It is still exported because `svelte/internal/client` exports it by name
 */
export function renderer_snippet(): never {
	unsupported('custom renderers');
}

/** See `renderer_snippet` */
export function validate_snippet_renderer(): never {
	unsupported('custom renderers');
}

/**
 * Create a snippet programmatically
 */
export function createRawSnippet<Params extends unknown[]>(
	fn: (...params: Getters<Params>) => {
		render: () => string;
		setup?: (element: Element) => void | (() => void);
	}
): Snippet<Params> {
	// @ts-expect-error the types are a lie
	return (anchor: TemplateNode, ...params: Getters<Params>) => {
		var snippet = fn(...params);

		var element: Element;

		if (hydrating) {
			element = hydrate_node as Element;
			hydrate_next();
		} else {
			var html = snippet.render().trim();
			var fragment = create_fragment_from_html(html);
			element = get_first_child(fragment) as Element;

			if (DEV && (get_next_sibling(element) !== null || element.nodeType !== ELEMENT_NODE)) {
				w.invalid_raw_snippet_render();
			}

			anchor.before(element);
		}

		if (DEV && dev_stack !== null) {
			// Raw snippets have no template locations, so use the render callsite.
			// This also keeps the surrounding template from claiming their root.
			// @ts-expect-error
			element.__svelte_meta = {
				parent: dev_stack,
				loc: { file: dev_stack.file, line: dev_stack.line, column: dev_stack.column },
				component: component_context
			};
		}

		const result = snippet.setup?.(element);
		assign_nodes(element, element);

		if (typeof result === 'function') {
			teardown(result);
		}
	};
}
