/**
 * AST post-processing of compiled Svelte client output (shared by plugins/svelte.ts and the
 * Svelte test-suite harness in scripts/svelte-tests.ts, so both apply the *same* transform).
 * Plain JS with injected acorn/magic-string: runs under Bun and Node.
 *
 * - `namedImports`: `import * as $ from 'svelte/internal/client'` -> named imports.
 * - `proxySet`: `$.set(x, v, true)` -> `$.set(x, $.proxy(v))`.
 * - `forbid`: throw if compiled output uses a runtime feature the variant removed.
 */

/**
 * @typedef {{ call: string; withProp?: { index: number; name: string }; message: string }} Forbidden
 */

/** @param {any} node @param {(node: any) => void} visit */
function walk(node, visit) {
	if (!node || typeof node.type !== 'string') return;
	visit(node);
	for (const key in node) {
		const value = node[key];
		if (Array.isArray(value)) for (const child of value) walk(child, visit);
		else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, visit);
	}
}

/** @param {any} n @param {string} [name] */
const isRuntimeCall = (n, name) =>
	n.type === 'CallExpression' &&
	n.callee.type === 'MemberExpression' &&
	n.callee.object.type === 'Identifier' &&
	n.callee.object.name === '$' &&
	!n.callee.computed &&
	(name === undefined || n.callee.property.name === name);

/**
 * AST post-processing of compiled client output. Throws on forbidden features.
 * @param {string} code
 * @param {string} file
 * @param {{ namedImports?: boolean; proxySet?: boolean; forbid?: Forbidden[] }} opts
 * @param {{ acorn: any; MagicString: any }} deps acorn + magic-string (injected, so this file
 *   runs under Bun (build) and Node (the Svelte test suite, scripts/svelte-tests.ts) alike)
 * @returns {string}
 */
export function transformCompiled(code, file, opts, { acorn, MagicString }) {
	if (!opts.namedImports && !opts.proxySet && !opts.forbid?.length) return code;
	const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module' });
	const s = new MagicString(code);

	// the namespace import emitted by the compiler
	const nsImport = ast.body.find(
		(n) =>
			n.type === 'ImportDeclaration' &&
			n.source.value === 'svelte/internal/client' &&
			n.specifiers.length === 1 &&
			n.specifiers[0].type === 'ImportNamespaceSpecifier' &&
			n.specifiers[0].local.name === '$'
	);

	const named = !!(opts.namedImports && nsImport);
	const proxyCallee = named ? '$__proxy' : '$.proxy';
	let insertedProxy = false;

	/** @param {any} n @param {Forbidden} f */
	const forbidden = (n, f) => {
		const line = code.slice(0, n.start).split('\n').length;
		return new Error(`[svelte-lite] ${file} (compiled line ${line}): ${f.message}`);
	};

	walk(ast, (n) => {
		// any use of a forbidden runtime export (called or passed as a reference, e.g. `$.eager($.pending)`)
		if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === '$') {
			const f = opts.forbid?.find((f) => f.call === n.property.name && !f.withProp);
			if (f) throw forbidden(n, f);
		}

		if (!isRuntimeCall(n)) return;
		const name = n.callee.property.name;

		for (const f of opts.forbid ?? []) {
			if (f.call !== name || !f.withProp) continue;
			const arg = n.arguments[f.withProp.index];
			const has = arg?.type === 'ObjectExpression' && arg.properties.some((p) => p.key?.name === /** @type {any} */ (f.withProp).name);
			if (has) throw forbidden(n, f);
		}

		if (opts.proxySet && name === 'set' && n.arguments.length === 3) {
			const [, value, flag] = n.arguments;
			if (flag.type !== 'Literal' || flag.value !== true) {
				throw new Error(`[svelte-lite] ${file}: unexpected 3rd argument to $.set(): ${code.slice(flag.start, flag.end)}`);
			}
			s.appendLeft(value.start, `${proxyCallee}(`);
			insertedProxy = true;
			s.overwrite(value.end, flag.end, ')');
		}
	});

	if (named) {
		// rewrite every `$.name` member access into a local binding `$__name`
		const used = new Set();
		walk(ast, (n) => {
			if (
				n.type === 'MemberExpression' &&
				!n.computed &&
				n.object.type === 'Identifier' &&
				n.object.name === '$' &&
				n.property.type === 'Identifier'
			) {
				used.add(n.property.name);
				s.overwrite(n.start, n.end, `$__${n.property.name}`);
			}
		});
		if (insertedProxy) used.add('proxy');
		s.overwrite(
			nsImport.start,
			nsImport.end,
			`import { ${[...used].map((n) => `${n} as $__${n}`).join(', ')} } from 'svelte/internal/client';`
		);
	}

	return s.toString();
}
