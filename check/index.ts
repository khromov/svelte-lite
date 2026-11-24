/**
 * Finds the syntax in a component that svelte-lite does not support: what Svelte deprecates
 * (`on:`, `<slot>`, `<svelte:component>` and the rest), what only legacy mode has (`export let`,
 * `$:`, `$$props`), what needs `experimental.async` (`await` in markup and at the top level of
 * a component) and what selects a custom renderer.
 *
 * It works from the AST of Svelte's own parser. `src/compiler/index.ts` runs it on every
 * component that it compiles, and `check/cli.ts` on the files of a project, for where
 * svelte-lite's compiler entry point is not the one that is called (SvelteKit, for one, calls
 * Svelte's).
 *
 * The rules are the table `RULES`: adding one is adding an entry.
 */
import { parse } from '../src/compiler/index.ts';

/** Why svelte-lite does not support it */
export type Kind = 'deprecated' | 'legacy' | 'async' | 'custom renderer';

export interface Finding {
	/** The rule that found it, or `parse_error` */
	rule: string;
	kind: Kind | 'parse error';
	/** The type of the node, and of its parent, as Svelte's parser names them */
	node: string | null;
	parent: string | null;
	/** Offsets in the source */
	start: number;
	end: number;
	/** 1-based */
	line: number;
	/** 0-based, as in Svelte's own warnings and errors */
	column: number;
	/** What was found, such as "`on:click`, an `on:` directive" */
	found: string;
	/** What to write instead, as a sentence that starts with a verb */
	instead: string;
}

export interface CheckOptions {
	/** For the file's line and column numbers, and the advice about `<svelte:self>` */
	filename?: string;
	/**
	 * Whether the component is compiled as a custom element, as Svelte's `customElement` compiler
	 * option says. `<svelte:options customElement>` in the file says so as well. A custom element
	 * renders its light DOM children through `<slot>`, which is not deprecated there
	 */
	customElement?: boolean;
	/**
	 * Whether `experimental.async` is on, which svelte-lite only supports when compiling for the
	 * server: the server runtime is Svelte's. `await` is then not a finding
	 */
	async?: boolean;
}

type Node = { type: string; start: number; end: number; [key: string]: any };

/** Where in the file a node is */
type Region = 'options' | 'module' | 'instance' | 'template';

interface Context {
	source: string;
	filename: string | undefined;
	custom_element: boolean;
	async: boolean;
	region: Region;
	/** The ancestors of the node, from the root of its region; the last one is its parent */
	path: Node[];
}

interface Rule {
	/** A name for the rule, in snake_case like Svelte's codes */
	code: string;
	kind: Kind;
	/** The type of node it looks at, as Svelte's parser names it */
	node: string;
	/** Which nodes of that type are a case of it, if not all of them */
	when?: (node: Node, context: Context) => boolean;
	found: (node: Node, context: Context) => string;
	instead: (node: Node, context: Context) => string;
}

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

const ELEMENTS = new Set(['RegularElement', 'SvelteElement']);

/** The special elements that `on:` can listen on as well */
const TARGETS = new Set(['SvelteWindow', 'SvelteDocument', 'SvelteBody']);

const COMPONENTS = new Set(['Component', 'SvelteComponent', 'SvelteSelf']);

/** `on:click|once|preventDefault` */
const directive = (node: Node) => ['on:' + node.name, ...node.modifiers].join('|');

/** What to do in place of the modifiers of an `on:` directive on an element */
const MODIFIERS: Record<string, string> = {
	preventDefault: 'call `event.preventDefault()` in the handler',
	stopPropagation: 'call `event.stopPropagation()` in the handler',
	stopImmediatePropagation: 'call `event.stopImmediatePropagation()` in the handler',
	self: 'check `event.target === event.currentTarget` in the handler',
	trusted: 'check `event.isTrusted` in the handler',
	once: 'add the listener with `on(element, type, handler, { once: true })` of `svelte/events`',
	passive: 'add the listener with `on(element, type, handler, { passive: true })` of `svelte/events`',
	nonpassive: 'add the listener with `on(element, type, handler, { passive: false })` of `svelte/events`'
};

/** The value of an attribute that is plain text, as in `name="header"` */
const text = (attribute: Node | undefined): string | undefined =>
	Array.isArray(attribute?.value) && attribute.value.length === 1 && attribute.value[0].type === 'Text'
		? attribute.value[0].data
		: undefined;

/** What to write in place of an `on:` directive with a handler, on an element */
function event_attribute(node: Node) {
	const capture = node.modifiers.includes('capture') ? 'capture' : '';
	const rest = node.modifiers.filter((m: string) => m !== 'capture').map((m: string) => MODIFIERS[m]);
	return [`use the \`on${node.name}${capture}\` attribute`, ...rest].join(', and ');
}

const parent = (context: Context) => context.path.at(-1);

/** Whether an identifier is a reference to something, as opposed to the name of a property */
function is_reference(node: Node, context: Context) {
	const up = parent(context);
	if (!up) return true;
	if (up.type === 'MemberExpression') return up.object === node || up.computed;
	if (up.type === 'Property' || up.type === 'PropertyDefinition' || up.type === 'MethodDefinition') {
		return up.value === node || up.computed || up.shorthand;
	}
	return true;
}

export const RULES: Rule[] = [
	// ---------------------------------------------------------------- deprecated syntax
	{
		code: 'event_directive',
		kind: 'deprecated',
		node: 'OnDirective',
		when: (node, context) => node.expression !== null && ELEMENTS.has(parent(context)!.type),
		found: (node) => `\`${directive(node)}\`, an \`on:\` directive`,
		instead: event_attribute
	},
	{
		code: 'event_forwarding',
		kind: 'deprecated',
		node: 'OnDirective',
		when: (node) => node.expression === null,
		found: (node) => `\`${directive(node)}\` without a handler, which forwards the event`,
		instead: (node, context) => {
			const element = parent(context)!;
			const prop = `on${node.name}`;
			return COMPONENTS.has(element.type)
				? `accept an \`${prop}\` callback prop and pass it on: \`<${element.name} {${prop}} />\``
				: `accept an \`${prop}\` callback prop and pass it to the element: \`<${element.name} {${prop}}>\``;
		}
	},
	{
		code: 'component_event',
		kind: 'deprecated',
		node: 'OnDirective',
		when: (node, context) => node.expression !== null && COMPONENTS.has(parent(context)!.type),
		found: (node) => `\`${directive(node)}\` on a component, which listens to its events`,
		instead: (node) =>
			`pass a callback prop, \`on${node.name}={...}\`, and have the component call it` +
			(node.modifiers.includes('once') ? ' (once: it can remember that it did)' : '')
	},
	{
		code: 'slot_element',
		kind: 'deprecated',
		node: 'SlotElement',
		// a custom element renders its light DOM children through it, which is not deprecated
		when: (_, context) => !context.custom_element,
		found: (node) => {
			const name = text(node.attributes.find((a: Node) => a.type === 'Attribute' && a.name === 'name'));
			return `\`<slot${name ? ` name="${name}"` : ''}>\`, which renders what the parent passes`;
		},
		instead: (node) => {
			const name = text(node.attributes.find((a: Node) => a.type === 'Attribute' && a.name === 'name'));
			const props = node.attributes.filter((a: Node) => a.type !== 'Attribute' || a.name !== 'name');
			const prop = name ?? 'children';
			return (
				`render a snippet prop: \`{@render ${prop}?.(${props.length > 0 ? '...' : ''})}\`` +
				(props.length > 0 ? `, with what the slot passes as arguments` : '')
			);
		}
	},
	{
		code: 'slot_attribute',
		kind: 'deprecated',
		node: 'Attribute',
		// on a child of a component, where it fills a slot (`<svelte:fragment>` has a rule of
		// its own). Anywhere else it is the attribute of HTML, for the slots of shadow DOM
		when: (node, context) =>
			node.name === 'slot' &&
			parent(context)!.type !== 'SvelteFragment' &&
			context.path.at(-2)?.type === 'Fragment' &&
			COMPONENTS.has(context.path.at(-3)?.type!),
		found: (node) => `\`slot="${text(node) ?? '...'}"\`, which fills a slot of the component`,
		instead: (node) => `pass a snippet: \`{#snippet ${text(node) ?? 'name'}()}...{/snippet}\``
	},
	{
		code: 'svelte_fragment',
		kind: 'deprecated',
		node: 'SvelteFragment',
		found: () => '`<svelte:fragment>`, which fills a slot of the component',
		instead: (node) => {
			const slot = text(node.attributes.find((a: Node) => a.type === 'Attribute' && a.name === 'slot'));
			return `pass a snippet: \`{#snippet ${slot ?? 'children'}()}...{/snippet}\``;
		}
	},
	{
		code: 'let_directive',
		kind: 'deprecated',
		node: 'LetDirective',
		found: (node) => `\`let:${node.name}\`, which takes a value that a slot passes`,
		instead: (node) =>
			`take it as a parameter of the snippet that you pass: \`{#snippet children(${node.name})}\``
	},
	{
		code: 'svelte_component',
		kind: 'deprecated',
		node: 'SvelteComponent',
		found: () => '`<svelte:component>`, which renders the component that `this` holds',
		instead: (node) =>
			node.expression.type === 'Identifier' && /^[A-Z]/.test(node.expression.name)
				? `use the variable as a tag, \`<${node.expression.name} />\`: components are dynamic in runes mode`
				: 'hold the component in a capitalised variable, `let Thing = $derived(...)`, and use it as a tag, `<Thing />`'
	},
	{
		code: 'svelte_self',
		kind: 'deprecated',
		node: 'SvelteSelf',
		found: () => '`<svelte:self>`, which renders the component itself',
		instead: (_, context) => {
			const basename = context.filename?.split(/[/\\]/).pop() ?? 'Self.svelte';
			const name = basename.replace(/\.svelte$/, '').replace(/[^\w$]/g, '_').replace(/^./, (c) => c.toUpperCase());
			return `import the component into itself, \`import ${name} from './${basename}'\`, and use \`<${name} />\``;
		}
	},
	{
		code: 'script_context',
		kind: 'deprecated',
		node: 'Attribute',
		when: (node, context) => node.name === 'context' && parent(context)?.type === 'Script',
		found: () => '`<script context="module">`',
		instead: () => 'write `<script module>`'
	},
	{
		code: 'options_accessors',
		kind: 'deprecated',
		node: 'Attribute',
		when: (node, context) => context.region === 'options' && node.name === 'accessors',
		found: () => '`accessors` in `<svelte:options>`, which has no effect in runes mode',
		instead: () => 'remove it: a component exposes what it exports'
	},
	{
		code: 'options_immutable',
		kind: 'deprecated',
		node: 'Attribute',
		when: (node, context) => context.region === 'options' && node.name === 'immutable',
		found: () => '`immutable` in `<svelte:options>`, which has no effect in runes mode',
		instead: () => 'remove it: what changes is known from `$state`, not from comparing values'
	},
	{
		code: 'window_event_directive',
		kind: 'deprecated',
		node: 'OnDirective',
		when: (node, context) => node.expression !== null && TARGETS.has(parent(context)!.type),
		found: (node, context) => `\`${directive(node)}\` on \`<${parent(context)!.name}>\`, an \`on:\` directive`,
		instead: event_attribute
	},

	// ---------------------------------------------------------------- legacy mode
	{
		code: 'export_let',
		kind: 'legacy',
		node: 'ExportNamedDeclaration',
		when: (node, context) => context.region === 'instance' && node.declaration?.kind === 'let',
		found: () => '`export let`, which declares a prop in legacy mode',
		instead: (node) => {
			const names = node.declaration.declarations.map((d: Node) => d.id.name ?? '...').join(', ');
			return `declare props with \`$props()\`: \`let { ${names} } = $props()\``;
		}
	},
	{
		code: 'reactive_statement',
		kind: 'legacy',
		node: 'LabeledStatement',
		when: (node, context) =>
			context.region === 'instance' && node.label.name === '$' && parent(context)?.type === 'Program',
		found: () => '`$:`, a reactive statement of legacy mode',
		instead: () => 'use `$derived` for a value that depends on others, `$effect` for a side effect'
	},
	{
		code: 'dollar_props',
		kind: 'legacy',
		node: 'Identifier',
		when: (node, context) => node.name === '$$props' && is_reference(node, context),
		found: () => '`$$props`, which only legacy mode has',
		instead: () => 'take the props from `$props()`: `let props = $props()`'
	},
	{
		code: 'dollar_rest_props',
		kind: 'legacy',
		node: 'Identifier',
		when: (node, context) => node.name === '$$restProps' && is_reference(node, context),
		found: () => '`$$restProps`, which only legacy mode has',
		instead: () => 'use a rest element in `$props()`: `let { a, ...rest } = $props()`'
	},
	{
		code: 'options_runes_false',
		kind: 'legacy',
		node: 'Attribute',
		when: (node, context) =>
			context.region === 'options' && node.name === 'runes' && node.value?.expression?.value === false,
		found: () => '`runes={false}` in `<svelte:options>`, which selects legacy mode',
		instead: () => 'remove it: every component is a runes component'
	},
	{
		code: 'attribute_sequence',
		kind: 'legacy',
		node: 'SequenceExpression',
		when: (node, context) => {
			const tag = parent(context);
			const attribute = context.path.at(-2);
			if (tag?.type !== 'ExpressionTag' || attribute?.type !== 'Attribute' || attribute.value !== tag) {
				return false;
			}

			// as Svelte's compiler tells: in parentheses, it is allowed
			let i = node.start;
			while (--i > 0) {
				if (context.source[i] === '(') return false;
				if (context.source[i] === '{') return true;
			}
			return false;
		},
		found: () => 'a comma-separated expression as the value of an attribute, which only legacy mode allows',
		instead: () => 'wrap it in parentheses'
	},

	// ---------------------------------------------------------------- `experimental.async`
	{
		code: 'await_expression',
		kind: 'async',
		node: 'AwaitExpression',
		// at the top level of the component's script, or in markup, and not inside a function
		when: (_, context) =>
			!context.async &&
			(context.region === 'instance' || context.region === 'template') &&
			!context.path.some((node) => FUNCTIONS.has(node.type)),
		found: (_, context) =>
			context.region === 'template'
				? '`await` in markup, which needs `experimental.async`'
				: '`await` at the top level of a component, which needs `experimental.async`',
		instead: () =>
			'use an `{#await}` block, or load the data in an `$effect` (or outside the component)'
	},

	// ---------------------------------------------------------------- custom renderers
	{
		code: 'options_custom_renderer',
		kind: 'custom renderer',
		node: 'Attribute',
		when: (node, context) => context.region === 'options' && node.name === 'customRenderer',
		found: () => '`customRenderer` in `<svelte:options>`, which selects a custom renderer',
		instead: () => 'remove it: svelte-lite renders to the DOM'
	}
];

/** The rules by the type of node they look at */
const RULES_BY_NODE = new Map<string, Rule[]>();
for (const rule of RULES) {
	RULES_BY_NODE.set(rule.node, [...(RULES_BY_NODE.get(rule.node) ?? []), rule]);
}

/** Calls `visit` for every node below `node` (and `node` itself), with its ancestors */
function walk(node: Node, path: Node[], visit: (node: Node, path: Node[]) => void) {
	visit(node, path);
	path.push(node);

	for (const key in node) {
		if (key === 'metadata') continue;
		const value = node[key];

		if (Array.isArray(value)) {
			for (const item of value) {
				if (item && typeof item.type === 'string') walk(item, path, visit);
			}
		} else if (value && typeof value === 'object' && typeof value.type === 'string') {
			walk(value, path, visit);
		}
	}

	path.pop();
}

/** Line and column of an offset, the way Svelte reports them: 1-based line, 0-based column */
function locator(source: string) {
	const starts = [0];
	for (let i = 0; i < source.length; i += 1) {
		if (source[i] === '\n') starts.push(i + 1);
	}

	return (offset: number) => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if (starts[middle] <= offset) low = middle;
			else high = middle - 1;
		}
		return { line: low + 1, column: offset - starts[low] };
	};
}

/** The syntax in `source`, a component, that svelte-lite does not support, in order */
export function check(source: string, options: CheckOptions = {}): Finding[] {
	const locate = locator(source);
	const findings: Finding[] = [];

	let root: any;

	try {
		root = parse(source, { modern: true, filename: options.filename } as any);
	} catch (error: any) {
		const start: number = error.position?.[0] ?? 0;
		return [
			{
				rule: 'parse_error',
				kind: 'parse error',
				node: null,
				parent: null,
				start,
				end: error.position?.[1] ?? start,
				...locate(start),
				found: 'a file that does not parse',
				instead: `fix what Svelte's parser says: ${String(error.message).split('\n')[0]}`
			}
		];
	}

	const context: Context = {
		source,
		filename: options.filename,
		custom_element: !!options.customElement || !!root.options?.customElement,
		async: !!options.async,
		region: 'template',
		path: []
	};

	const visit = (node: Node, path: Node[]) => {
		const rules = RULES_BY_NODE.get(node.type);
		if (!rules) return;

		context.path = path;

		for (const rule of rules) {
			if (rule.when && !rule.when(node, context)) continue;

			findings.push({
				rule: rule.code,
				kind: rule.kind,
				node: node.type,
				parent: path.at(-1)?.type ?? null,
				start: node.start,
				end: node.end,
				...locate(node.start),
				found: rule.found(node, context),
				instead: rule.instead(node, context)
			});
		}
	};

	const regions: Array<[Region, Node | null | undefined]> = [
		['module', root.module],
		['instance', root.instance],
		['template', root.fragment]
	];

	if (root.options) {
		context.region = 'options';
		for (const attribute of root.options.attributes) walk(attribute, [root.options], visit);
	}

	for (const [region, node] of regions) {
		if (!node) continue;
		context.region = region;
		walk(node, [], visit);
	}

	return findings.sort((a, b) => a.start - b.start);
}

/** "`on:click`, an `on:` directive (App.svelte:3:9): use the `onclick` attribute", with a 1-based column */
export function describe(finding: Finding, filename = 'the component') {
	return `${finding.found} (${filename}:${finding.line}:${finding.column + 1}): ${finding.instead}`;
}
