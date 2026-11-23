import type { Boundary, Effect, TemplateNode } from '../../types.ts';
import {
	BOUNDARY_EFFECT,
	DESTROYED,
	DESTROYING,
	EFFECT_PRESERVED,
	EFFECT_TRANSPARENT
} from '../../constants.ts';
import {
	HYDRATION_ERROR,
	HYDRATION_START_ELSE,
	HYDRATION_START_FAILED
} from '../../../../constants.ts';
import { component_context, set_component_context } from '../../context.ts';
import { invoke_error_boundary, set_has_boundaries } from '../../error-handling.ts';
import { block, branch, destroy_effect, pause_effect } from '../../reactivity/effects.ts';
import {
	active_effect,
	active_reaction,
	set_active_effect,
	set_active_reaction
} from '../../runtime.ts';
import {
	hydrate_next,
	hydrate_node,
	hydrating,
	next,
	read_hydration_instruction,
	skip_nodes,
	set_hydrate_node,
	set_hydrating
} from '../hydration.ts';
import { queue_micro_task } from '../task.ts';
import * as e from '../../errors.ts';
import * as w from '../../warnings.ts';

type BoundaryProps = {
	onerror?: ((error: unknown, reset: () => void) => void) | null;
	failed?: ((anchor: Node, error: () => unknown, reset: () => () => void) => void) | null;
	/**
	 * Shown while asynchronous work inside the boundary is pending, which there is none of
	 * without `experimental.async`: the children render right away
	 */
	pending?: ((anchor: Node) => void) | null;
};

/**
 * `<svelte:boundary>`: renders `children`, and when an error is thrown while they render or update,
 * removes them, calls `onerror` and renders the `failed` snippet in their place
 * @param transform_error the `transformError` option of `mount` and `hydrate`. A boundary
 * inherits it from the one around it
 */
export function boundary(
	node: TemplateNode,
	props: BoundaryProps,
	children: (anchor: Node) => void,
	transform_error?: (error: unknown) => unknown
): void {
	set_has_boundaries();

	var anchor = node;
	var hydrate_open = hydrating ? hydrate_node : null;

	var main_effect: Effect | null = null;
	var failed_effect: Effect | null = null;

	if (!transform_error) {
		// take it from the boundary around this one, or else from `mount`
		for (var above = active_effect; above !== null && !transform_error; above = above.parent) {
			transform_error = above.b?.transform_error;
		}
	}

	var self: Boundary = { error: fail, transform_error };

	/** Makes the effect that is running one whose errors this boundary handles */
	function own(): void {
		var effect = active_effect as Effect;

		effect.b = self;
		effect.f |= BOUNDARY_EFFECT;
	}

	function is_destroyed(): boolean {
		return (effect.f & (DESTROYED | DESTROYING)) !== 0;
	}

	function render(): void {
		try {
			main_effect = branch(() => {
				own();
				children(anchor);
			});
		} catch (error) {
			fail(error);
		}
	}

	/** Runs `fn` as if the boundary's own effect was running, after the fact */
	function run<T>(fn: () => T): T {
		var previous_effect = active_effect;
		var previous_reaction = active_reaction;
		var previous_ctx = component_context;

		set_active_effect(effect);
		set_active_reaction(effect);
		set_component_context(effect.ctx);

		try {
			return fn();
		} finally {
			set_active_effect(previous_effect);
			set_active_reaction(previous_reaction);
			set_component_context(previous_ctx);
		}
	}

	/**
	 * Creates the `reset` function for a failed boundary, along with a function
	 * that invokes `onerror` with it (if provided)
	 */
	function create_reset(error: unknown): { reset: () => void; invoke_onerror: () => void } {
		var did_reset = false;
		var calling_on_error = false;

		const reset = () => {
			if (is_destroyed()) return;

			if (did_reset) {
				w.svelte_boundary_reset_noop();
				return;
			}

			did_reset = true;

			if (calling_on_error) {
				e.svelte_boundary_reset_onerror();
			}

			if (failed_effect !== null) {
				pause_effect(failed_effect, () => {
					failed_effect = null;
				});
			}

			run(render);
		};

		const invoke_onerror = () => {
			if (is_destroyed()) return;

			try {
				calling_on_error = true;
				props.onerror?.(error, reset);
				calling_on_error = false;
			} catch (err) {
				invoke_error_boundary(err, effect.parent);
			}
		};

		return { reset, invoke_onerror };
	}

	/**
	 * Handles an error from inside the boundary, or throws it for the next boundary to handle
	 */
	function fail(error: unknown): void {
		if (hydrating && error === HYDRATION_ERROR) {
			throw error;
		}

		var failed = props.failed;

		// If we have nothing to capture the error, or if we hit an error while
		// rendering the fallback, re-throw for another boundary to handle
		if (!props.onerror && !failed) {
			throw error;
		}

		if (main_effect) {
			destroy_effect(main_effect);
			main_effect = null;
		}

		if (failed_effect) {
			destroy_effect(failed_effect);
			failed_effect = null;
		}

		if (hydrating) {
			set_hydrate_node(hydrate_open as TemplateNode);
			next();
			set_hydrate_node(skip_nodes());
		}

		const handle_error_result = (transformed_error: unknown) => {
			if (is_destroyed()) return;

			const { reset, invoke_onerror } = create_reset(transformed_error);

			invoke_onerror();

			if (failed && !is_destroyed()) {
				failed_effect = run(() => {
					try {
						return branch(() => {
							// errors in `failed` snippets cause the boundary to error again
							// TODO Svelte 6: revisit this decision, most likely better to go to parent boundary instead
							own();

							failed!(
								anchor,
								() => transformed_error,
								() => reset
							);
						});
					} catch (error) {
						invoke_error_boundary(error, effect.parent);
						return null;
					}
				});
			}
		};

		queue_micro_task(() => {
			if (is_destroyed()) return;

			// Run the error through the API-level transformError transform (e.g. SvelteKit's handleError)
			var result: unknown = error;

			try {
				if (self.transform_error) result = self.transform_error(error);
			} catch (e) {
				invoke_error_boundary(e, effect.parent);
				return;
			}

			if (
				result !== null &&
				typeof result === 'object' &&
				typeof (result as any).then === 'function'
			) {
				// transformError returned a Promise — wait for it
				(result as any).then(handle_error_result, (e: unknown) =>
					invoke_error_boundary(e, effect.parent)
				);
			} else {
				// Synchronous result — handle immediately
				handle_error_result(result);
			}
		});
	}

	var effect = block(() => {
		if (hydrating) {
			var data = read_hydration_instruction(hydrate_open as TemplateNode);
			hydrate_next();

			if (data.startsWith(HYDRATION_START_FAILED)) {
				// Server rendered the failed snippet - hydrate it.
				// The serialized error is embedded in the comment: <!--[?<json>-->
				var serialized_error = JSON.parse(data.slice(HYDRATION_START_FAILED.length));
				var failed = props.failed;
				var { reset, invoke_onerror } = create_reset(serialized_error);

				// `onerror` may mutate state, which is disallowed while hydrating
				queue_micro_task(invoke_onerror);

				if (failed) {
					failed_effect = branch(() => {
						failed!(
							anchor,
							() => serialized_error,
							() => reset
						);
					});
				}

				return;
			}

			if (data === HYDRATION_START_ELSE) {
				// The server rendered the `pending` snippet, which is never shown here:
				// remove it and render the children from scratch
				anchor = set_hydrate_node(skip_nodes());

				set_hydrating(false);
				render();
				set_hydrating(true);

				return;
			}
		}

		render();
	}, EFFECT_TRANSPARENT | EFFECT_PRESERVED);

	if (hydrating) {
		anchor = hydrate_node;
	}
}

/**
 * `$effect.pending()`: the number of promises that are pending in the boundary of the
 * current effect. Without `experimental.async`, nothing ever is
 */
export function pending(): number {
	return 0;
}
