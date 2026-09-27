/**
 * `minimal`: the svelte-lite feature drops, each a Technique so COMPARISON.md can stack
 * them one at a time on top of `optimized`. Every patch anchors on real code (see
 * patches/util.ts) and fails the build if the anchor is gone. See PATCHES.md.
 *
 * Techniques are cumulative in STACK order (variants.ts): later ones may assume earlier
 * ones were applied to the same file.
 */
import type { Technique } from '../variants.ts';
import { code, unsupported } from './util.ts';

const BATCH = 'src/internal/client/reactivity/batch.js';
const SOURCES = 'src/internal/client/reactivity/sources.js';
const EFFECTS = 'src/internal/client/reactivity/effects.js';
const FLAGS = 'src/internal/flags/index.js';
const EACH = 'src/internal/client/dom/blocks/each.js';
const BRANCHES = 'src/internal/client/dom/blocks/branches.js';
const BOUNDARY = 'src/internal/client/dom/blocks/boundary.js';
const RENDER = 'src/internal/client/render.js';
const EVENTS = 'src/internal/client/dom/elements/events.js';

// ---------------------------------------------------------------------------------------------
// 1. Legacy mode (Svelte 4 syntax): runes only

export const LEGACY: Technique = {
	// legacy syntax becomes a compile error instead of silently needing the legacy runtime
	compilerOptions: { runes: true },
	constImports: [
		{
			from: FLAGS,
			values: { legacy_mode_flag: 'false' },
			feature: 'legacy',
			why: 'runes-only: legacy_mode_flag as a foldable const (is_runes() becomes `true`)'
		}
	],
	patches: [
		{
			file: FLAGS,
			feature: 'legacy',
			why: 'legacy_mode_flag is a constant; enabling legacy mode throws',
			replace: [
				['export let legacy_mode_flag = false;', 'export const legacy_mode_flag = false;', 1],
				[code`export function enable_legacy_mode_flag() { legacy_mode_flag = true; }`, `export function enable_legacy_mode_flag() { ${unsupported('legacy mode (Svelte 4 syntax)')}; }`, 1]
			]
		},
		{
			file: BATCH,
			feature: 'legacy',
			why: 'drop `legacy_updates` (set() during traversal is deferred to a new batch only for legacy `$:`/stores); writes during traversal are scheduled on the current batch like internal_set()',
			replace: [
				['export let legacy_updates = null;', '', 1],
				['var updates = (legacy_updates = []);', '', 1],
				[code`if (updates.length > 0) { var batch = Batch.ensure(); for (const e of updates) { batch.schedule(e); } }`, '', 1],
				[code`if (updates.length > 0) { /** @type {Batch} */ (/** @type {unknown} */ (current_batch)).#process(); }`, '', 1],
				['legacy_updates = null;', '', 2]
			]
		},
		{
			file: SOURCES,
			feature: 'legacy',
			why: 'set() no longer routes through `legacy_updates`; mark_reactions always schedules',
			replace: [
				[code`schedule_effect, legacy_updates } from './batch.js';`, "schedule_effect } from './batch.js';", 1],
				['return internal_set(source, new_value, legacy_updates);', 'return internal_set(source, new_value);', 1],
				['export function internal_set(source, value, updated_during_traversal = null) {', 'export function internal_set(source, value) {', 1],
				['mark_reactions(source, DIRTY, updated_during_traversal);', 'mark_reactions(source, DIRTY);', 1],
				['function mark_reactions(signal, status, updated_during_traversal) {', 'function mark_reactions(signal, status) {', 1],
				['mark_reactions(derived, MAYBE_DIRTY, updated_during_traversal);', 'mark_reactions(derived, MAYBE_DIRTY);', 1],
				[code`if (updated_during_traversal !== null) { updated_during_traversal.push(effect); } else { schedule_effect(effect); }`, 'schedule_effect(effect);', 1]
			]
		}
	]
};

// ---------------------------------------------------------------------------------------------
// 2. Async (experimental.async, fork, settled, $effect.pending, pending snippets)

const ASYNC_ONLY_BATCH_MEMBERS = [
	// fork / multi-batch rebasing
	'#is_deferred', '#find_earlier_batch', '#merge', '#commit', 'skip_effect', 'unskip_effect',
	'is_fork', '#skipped_branches', '#unskipped_branches', '#new_effects', 'register_created_effect',
	// deferred (pending) effects
	'#defer_effects', 'transfer_effects', '#dirty_effects', '#maybe_dirty_effects',
	// async work in flight
	'increment', 'decrement', '#pending', '#blocking_pending', '#decrement_queued', 'async_deriveds',
	// commit/discard/settled callbacks (only ever registered by the async/fork paths)
	'oncommit', 'ondiscard', '#commit_callbacks', '#discard_callbacks', 'settled', '#deferred'
];

const ASYNC_ONLY_BOUNDARY_MEMBERS = [
	'is_pending', 'is_rendered', 'has_pending_snippet', '#hydrate_pending_content', '#pending_effect',
	'#offscreen_fragment', '#pending_count', '#local_pending_count', '#pending_count_update_queued',
	'#update_pending_count', 'update_pending_count', '#effect_pending', '#effect_pending_subscriber',
	'get_effect_pending', 'defer_effect', '#dirty_effects', '#maybe_dirty_effects', '#resolve'
];

export const ASYNC: Technique = {
	constImports: [
		{
			from: FLAGS,
			values: { async_mode_flag: 'false' },
			feature: 'async',
			why: 'sync-only: async_mode_flag as a foldable const'
		}
	],
	svelte: {
		forbid: [
			{ call: 'pending', message: 'svelte-lite: $effect.pending() is not supported (async was removed)' },
			{
				call: 'boundary',
				withProp: { index: 1, name: 'pending' },
				message: 'svelte-lite: <svelte:boundary> `pending` is not supported (async was removed)'
			}
		]
	},
	patches: [
		{
			file: FLAGS,
			feature: 'async',
			why: 'async_mode_flag is a constant; enabling async mode throws',
			replace: [
				['export let async_mode_flag = false;', 'export const async_mode_flag = false;', 1],
				[code`export function enable_async_mode_flag() { async_mode_flag = true; }`, `export function enable_async_mode_flag() { ${unsupported('experimental.async')}; }`, 1],
				[code`export function disable_async_mode_flag() { async_mode_flag = false; }`, 'export function disable_async_mode_flag() {}', 1]
			]
		},
		{
			file: BATCH,
			feature: 'async',
			why: 'strip the async/fork-only members of Batch and their call sites in #process/#traverse/discard/schedule/capture (sync batches never defer, fork or rebase)',
			removeMembers: { class: 'Batch', members: ASYNC_ONLY_BATCH_MEMBERS },
			replace: [
				// #process: previously-deferred effects (only ever deferred by async/pending boundaries)
				[code`for (const e of this.#dirty_effects) { this.#maybe_dirty_effects.delete(e); set_signal_status(e, DIRTY); this.schedule(e); } for (const e of this.#maybe_dirty_effects) { set_signal_status(e, MAYBE_DIRTY); this.schedule(e); }`, '', 1],
				['if (!this.#is_deferred()) this.discard();', 'this.discard();', 1],
				[code`if (this.#is_deferred()) { this.#defer_effects(render_effects); this.#defer_effects(effects); for (const [e, t] of this.#skipped_branches) { reset_branch(e, t); } return; }`, '', 1],
				[/const earlier_batch = this\.#find_earlier_batch\(\);[\s\S]*?earlier_batch\.#merge\(this\);\s*return;\s*\}/, '', 1],
				[code`this.#dirty_effects.clear(); this.#maybe_dirty_effects.clear();`, '', 1],
				[code`for (const fn of this.#commit_callbacks) fn(this); this.#commit_callbacks.clear();`, '', 1],
				['this.#deferred?.resolve();', '', 2],
				['if (this.#pending === 0 && (this.#scheduled.length === 0 || next_batch !== null)) {', 'if (this.#scheduled.length === 0 || next_batch !== null) {', 1],
				[/if \(async_mode_flag\) \{\s*this\.#commit\(\);[\s\S]*?current_batch = next_batch;\s*\}/, '', 1],
				// #traverse
				['|| (flags & INERT) !== 0 || this.#skipped_branches.has(effect);', '|| (flags & INERT) !== 0;', 1],
				['if ((flags & BLOCK_EFFECT) !== 0) this.#maybe_dirty_effects.add(effect);', '', 1],
				// discard()
				[code`for (const fn of this.#discard_callbacks) fn(this); this.#discard_callbacks.clear(); for (const deferred of this.async_deriveds.values()) { deferred.reject(OBSOLETE); }`, '', 1],
				// schedule(): effects inside a pending boundary are deferred
				[code`if ( effect.b?.is_pending && (effect.f & (EFFECT | RENDER_EFFECT | MANAGED_EFFECT)) !== 0 && (effect.f & REACTION_RAN) === 0 ) { effect.b.defer_effect(effect); return; }`, '', 1],
				// capture(): forks keep source values untouched
				[code`if (!this.is_fork) { source.v = value; }`, 'source.v = value;', 1]
			],
			replaceFunctions: { fork: { hash: '1c0b8a20033418bf', code: `function fork(fn) { ${unsupported('fork()')}; }` } }
		},
		{
			file: EFFECTS,
			feature: 'async',
			why: 'effects are only registered with the batch for fork rebasing',
			replace: [['current_batch?.register_created_effect(effect);', '', 1]]
		},
		{
			file: 'src/internal/client/runtime.js',
			feature: 'async',
			why: 'settled() waits for async work; stub',
			replaceFunctions: { settled: { hash: '7880023f4d03e5c5', code: `function settled() { ${unsupported('settled()')}; }` } }
		},
		{
			file: 'src/internal/client/reactivity/async.js',
			feature: 'async',
			why: 'template_effect -> flatten(): keep the sync fast path, the async slow path (async_derived, blockers) throws',
			replaceFunctions: {
				flatten: {
					hash: 'ce0c74710a693d7b',
					code: `function flatten(blockers, sync, async, fn) {
	if (async.length > 0 || blockers.some((b) => !b.settled)) ${unsupported('async (experimental.async)')};
	if (DEV) {
		// kept verbatim from upstream: labels template-expression deriveds for $inspect.trace.
		// Self-contained (block-scoped const + return) so production output is byte-identical:
		// Bun doesn't inline a single-use var, so sharing one would cost 8 B in production.
		const deriveds = sync.map(is_runes() ? derived : derived_safe_equal);
		deriveds.forEach((d, i) => {
			d.label = sync[i]
				.toString()
				.replace('() => ', '')
				.replaceAll('$.eager(() => ', '$state.eager(')
				.replace(/\\$\\.get\\((.+?)\\)/g, (_, id) => id);
		});
		fn(deriveds);
		return;
	}
	fn(sync.map(is_runes() ? derived : derived_safe_equal));
}`
				}
			}
		},
		{
			file: EACH,
			feature: 'async',
			why: 'should_defer_append() is always false without async; fold the multi-batch skip/commit/discard paths (the const must lead its function body for Bun to fold it)',
			replace: [
				['var defer = should_defer_append();', '', 1],
				['var effect = block(() => {', 'var effect = block(() => {\n\t\tconst defer = false;', 1]
			],
			removeFunctions: ['discard']
		},
		{
			file: BRANCHES,
			feature: 'async',
			why: 'should_defer_append() is always false without async; fold the offscreen/multi-batch paths (the const must lead its function body for Bun to fold it)',
			replace: [
				['var defer = should_defer_append();', '', 1],
				['\tensure(key, fn) {', '\tensure(key, fn) {\n\t\tconst defer = false;', 1]
			]
		},
		{
			file: BOUNDARY,
			feature: 'async',
			why: 'strip pending-snippet / $effect.pending members of Boundary (error boundaries keep working); pending() throws',
			removeMembers: { class: 'Boundary', members: ASYNC_ONLY_BOUNDARY_MEMBERS },
			replace: [
				['const server_rendered_pending = comment.data === HYDRATION_START_ELSE;', '', 1],
				[code`} else if (server_rendered_pending) { this.#hydrate_pending_content(); } else {`, '} else {', 1],
				[code`this.is_pending = this.has_pending_snippet(); this.#pending_count = 0; this.#local_pending_count = 0;`, '', 1],
				[/if \(this\.#pending_count > 0\) \{[\s\S]*?\} else \{\s*this\.#resolve\([^)]*\)\);\s*\}/, '', 1],
				[/if \(current_batch\?\.is_fork\) \{[\s\S]*?\} else \{\s*this\.#handle_error\(error\);\s*\}/, 'this.#handle_error(error);', 1],
				[code`if (this.#pending_effect) { destroy_effect(this.#pending_effect); this.#pending_effect = null; }`, '', 1]
			],
			replaceFunctions: { pending: { hash: '5ba07822338d0ef3', code: `function pending() { ${unsupported('$effect.pending()')}; }` } }
		}
	]
};
// ---------------------------------------------------------------------------------------------
// 3. Transitions and animations (transition:, in:, out:, animate:)

export const TRANSITIONS: Technique = {
	svelte: {
		forbid: [
			{ call: 'transition', message: 'svelte-lite: transition:/in:/out: are not supported (transitions were removed)' },
			{ call: 'animation', message: 'svelte-lite: animate: is not supported (animations were removed)' }
		]
	},
	patches: [
		{
			file: EFFECTS,
			feature: 'transitions',
			why: 'no transitions: destroy/pause/resume never collect, run or stop `effect.nodes.t`; unmount({ outro }) destroys immediately',
			replace: [
				// destroy_effect
				[code`var transitions = effect.nodes && effect.nodes.t; if (transitions !== null) { for (const transition of transitions) { transition.stop(); } }`, '', 1],
				// pause_effect: nothing to wait for
				[code`var remaining = transitions.length; if (remaining > 0) { var check = () => --remaining || fn(); for (var transition of transitions) { transition.out(check); } } else { fn(); }`, 'fn();', 1],
				// pause_children
				[code`var t = effect.nodes && effect.nodes.t; if (t !== null) { for (const transition of t) { if (transition.is_global || local) { transitions.push(transition); } } }`, '', 1],
				// resume_children
				[code`var t = effect.nodes && effect.nodes.t; if (t !== null) { for (const transition of t) { if (transition.is_global || local) { transition.in(); } } }`, '', 1],
				// component_root(): unmount(app, { outro: true })
				[code`if (options.outro) { pause_effect(effect, () => { destroy_effect(effect); fulfil(undefined); }); } else { destroy_effect(effect); fulfil(undefined); }`, 'destroy_effect(effect); fulfil(undefined);', 1]
			]
		},
		{
			file: EACH,
			feature: 'transitions',
			why: 'no animate:/outros in {#each}: is_animated is constant false, removed items are destroyed immediately (no outro groups)',
			replace: [
				['var is_animated = (flags & EACH_IS_ANIMATED) !== 0;', 'const is_animated = false;', 1],
				[code`if (state.outrogroups !== null) { for (const group of state.outrogroups) { group.pending.delete(effect); group.done.delete(effect); } }`, '', 1],
				[/if \(state\.outrogroups !== null\) \{\s*for \(const group of state\.outrogroups\) \{\s*if \(group\.pending\.size === 0\) \{[\s\S]*?state\.outrogroups = null;\s*\}\s*\}/, '', 1],
				['outrogroups: null, ', '', 1]
			],
			replaceFunctions: {
				pause_effects: {
					hash: '5e54fd5b956c0d00',
					code: `function pause_effects(state, to_destroy, controlled_anchor) {
	// svelte-lite: without transitions every paused item is done immediately
	for (var i = 0; i < to_destroy.length; i++) pause_effect(to_destroy[i], null, false);
	var fast_path = controlled_anchor !== null && state.pending.size === 0;
	if (fast_path) {
		var anchor = /** @type {Element} */ (controlled_anchor);
		var parent_node = /** @type {Element} */ (anchor.parentNode);
		clear_text_content(parent_node);
		parent_node.append(anchor);
		state.items.clear();
	}
	destroy_effects(state, to_destroy, !fast_path);
}`
				}
			}
		},
		{
			file: BRANCHES,
			feature: 'transitions',
			why: 'no outros in if/key/component branches: switched-away branches are destroyed immediately (#outroing, #transition gone)',
			removeMembers: { class: 'BranchManager', members: ['#outroing', '#transition'] },
			replace: [
				['this.#outroing.delete(key);', '', 1],
				['if (k === key || this.#outroing.has(k)) continue;', 'if (k === key) continue;', 1],
				['this.#outroing.delete(k);', '', 1],
				[code`if (this.#transition || !onscreen) { this.#outroing.add(k); pause_effect(effect, on_destroy, false); } else { on_destroy(); }`, 'on_destroy();', 1],
				['this.#transition = transition;', '', 1]
			]
		},
		{
			file: RENDER,
			feature: 'transitions',
			why: 'should_intro only gates intro transitions',
			replace: [
				[/\n\t+should_intro = intro;\n/, '\n', 1],
				[/\n\t+should_intro = true;\n/, '\n', 1]
			]
		}
	]
};
// ---------------------------------------------------------------------------------------------
// 4. Root boundary: hydrate()/mount() no longer wrap the app in a <svelte:boundary>

export const ROOT_BOUNDARY: Technique = {
	patches: [
		{
			file: RENDER,
			feature: 'root-boundary',
			why: '_mount renders the component in a plain branch instead of a root Boundary (loses the `transformError` option and root-level pending/failed handling). The SSR root is `<!--[-->app<!--]-->` with no boundary-specific marker: the Boundary only consumed the opening `<!--[-->`, so _mount now does that itself (hydrate_next()); the closing marker check is unchanged',
			replace: [
				[code`boundary( /** @type {TemplateNode} */ (anchor_node), { pending: () => {} }, (anchor_node) => {`, 'if (hydrating) hydrate_next();\n\t\tbranch(() => ((anchor_node) => {', 1],
				[code`pop(); }, transformError );`, 'pop();\n\t\t\t})(anchor_node));', 1],
				["import { boundary } from './dom/blocks/boundary.js';", '', 1],
				["import { component_root } from './reactivity/effects.js';", "import { branch, component_root } from './reactivity/effects.js';", 1],
				[
					"import { hydrate_node, hydrating, set_hydrate_node, set_hydrating } from './dom/hydration.js';",
					"import { hydrate_next, hydrate_node, hydrating, set_hydrate_node, set_hydrating } from './dom/hydration.js';",
					1
				]
			]
		}
	]
};

// ---------------------------------------------------------------------------------------------
// 5. Lazy event delegation: root listeners are managed by events.js and only reachable
//    once some component calls delegate()

const REGISTER = `
/**
 * svelte-lite: lazy event delegation. The root-listener bookkeeping that _mount() did
 * eagerly (moved verbatim from render.js) is only reachable once a component calls
 * delegate(), so apps without delegated events don't ship handle_event_propagation.
 * @type {null | { register: (target: EventTarget, registered_events: Set<string>, events: string[]) => void, unregister: (target: EventTarget, registered_events: Set<string>) => void }}
 */
export let delegation = null;

/** @type {Map<EventTarget, Map<string, number>>} */
const listeners = new Map();

function register(target, registered_events, events) {
	for (var i = 0; i < events.length; i++) {
		var event_name = events[i];
		if (registered_events.has(event_name)) continue;
		registered_events.add(event_name);
		var passive = is_passive_event(event_name);
		for (const node of [target, document]) {
			var counts = listeners.get(node);
			if (counts === undefined) {
				counts = new Map();
				listeners.set(node, counts);
			}
			var count = counts.get(event_name);
			if (count === undefined) {
				node.addEventListener(event_name, handle_event_propagation, { passive });
				counts.set(event_name, 1);
			} else {
				counts.set(event_name, count + 1);
			}
		}
	}
}

function unregister(target, registered_events) {
	for (var event_name of registered_events) {
		for (const node of [target, document]) {
			var counts = /** @type {Map<string, number>} */ (listeners.get(node));
			var count = /** @type {number} */ (counts.get(event_name));
			if (--count == 0) {
				node.removeEventListener(event_name, handle_event_propagation);
				counts.delete(event_name);
				if (counts.size === 0) listeners.delete(node);
			} else {
				counts.set(event_name, count);
			}
		}
	}
}
`;

export const DELEGATION: Technique = {
	patches: [
		{
			file: RENDER,
			feature: 'delegation',
			why: '_mount keeps its per-root registration hook but delegates listener management to events.js `delegation` (null until a component calls delegate())',
			replace: [
				{
					// the eager per-root registration (moved to events.js register())
					find: /var event_handle = \(events\) => \{[\s\S]*?\n\t\t\};\n/,
					replace: 'var event_handle = (events) => delegation?.register(target, registered_events, events);\n',
					count: 1,
					hash: '86dedd6f008d8717'
				},
				{
					// the per-root cleanup (moved to events.js unregister())
					find: /for \(var event_name of registered_events\) \{[\s\S]*?\n\t\t\t\}\n/,
					replace: 'delegation?.unregister(target, registered_events);\n',
					count: 1,
					hash: '2a7ff352f36b2381'
				},
				[code`import { all_registered_events, handle_event_propagation, root_event_handles } from './dom/elements/events.js';`, "import { all_registered_events, delegation, root_event_handles } from './dom/elements/events.js';", 1],
				["import { is_passive_event } from '../../utils.js';", '', 1],
				[code`/** @type {Map<EventTarget, Map<string, number>>} */ const listeners = new Map();`, '', 1]
			]
		},
		{
			file: EVENTS,
			feature: 'delegation',
			why: 'root-listener bookkeeping (register/unregister, moved from render.js) is installed by the first delegate() call',
			replace: [
				[code`export function delegate(events) {`, 'export function delegate(events) {\n\tdelegation ??= { register, unregister };', 1],
				[code`import { without_reactive_context } from './bindings/shared.js';`, `import { without_reactive_context } from './bindings/shared.js';\nimport { is_passive_event } from '../../../../utils.js';\n${REGISTER}`, 1]
			]
		}
	]
};

// ---------------------------------------------------------------------------------------------
// 6. Tree-shakable $state proxy: the compiler-emitted `$.set(x, v, true)` becomes
//    `$.set(x, $.proxy(v))` (plugins/svelte.ts, AST), so set() no longer references proxy()

export const PROXY: Technique = {
	svelte: { proxySet: true },
	patches: [
		{
			file: SOURCES,
			feature: 'proxy',
			why: 'set() loses its `should_proxy` flag and its reference to proxy(); callers that need a proxy pass `proxy(value)` (compiled code via plugins/svelte.ts, proxy.js below)',
			replace: [
				['export function set(source, value, should_proxy = false) {', 'export function set(source, value) {', 1],
				['let new_value = should_proxy ? proxy(value) : value;', 'let new_value = value;', 1],
				["import { proxy } from '../proxy.js';", '', 1]
			]
		},
		{
			file: 'src/internal/client/proxy.js',
			feature: 'proxy',
			why: 'the one runtime-internal `set(s, v, true)` call (defineProperty trap) proxies explicitly',
			replace: [['set(s, descriptor.value, true);', 'set(s, proxy(descriptor.value));', 1]]
		}
	]
};
