import type { Effect, Source, TemplateNode } from '../../types.ts';
import {
	BOUNDARY_EFFECT,
	DESTROYED,
	DESTROYING,
	DIRTY,
	EFFECT_PRESERVED,
	EFFECT_TRANSPARENT,
	MAYBE_DIRTY
} from '../../constants.ts';
import {
	HYDRATION_ERROR,
	HYDRATION_START_ELSE,
	HYDRATION_START_FAILED
} from '../../../../constants.ts';
import { component_context, set_component_context } from '../../context.ts';
import { invoke_error_boundary } from '../../error-handling.ts';
import {
	block,
	branch,
	destroy_effect,
	move_effect,
	pause_effect
} from '../../reactivity/effects.ts';
import {
	active_effect,
	active_reaction,
	get,
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
	set_hydrate_node
} from '../hydration.ts';
import { queue_micro_task } from '../task.ts';
import * as e from '../../errors.ts';
import * as w from '../../warnings.ts';
import { DEV } from 'esm-env';
import { Batch, current_batch } from '../../reactivity/batch.ts';
import { internal_set, source } from '../../reactivity/sources.ts';
import { tag } from '../../dev/tracing.ts';
import { createSubscriber } from '../../../../reactivity/create-subscriber.ts';
import { create_text, create_fragment } from '../operations.ts';
import { set_signal_status } from '../../reactivity/status.ts';

type BoundaryProps = {
	onerror?: ((error: unknown, reset: () => void) => void) | null;
	failed?: ((anchor: Node, error: () => unknown, reset: () => () => void) => void) | null;
	pending?: ((anchor: Node) => void) | null;
};

var flags = EFFECT_TRANSPARENT | EFFECT_PRESERVED;

export function boundary(
	node: TemplateNode,
	props: BoundaryProps,
	children: (anchor: Node) => void,
	transform_error?: (error: unknown) => unknown
): void {
	new Boundary(node, props, children, transform_error);
}

/**
 * `types.ts` is still Svelte's declaration file. The boundary that the type of an effect refers
 * to (`Effect#b`) is the class in Svelte's own module, and a class with `#private` members is a
 * nominal type: only its own instances are assignable to it. Until `types.ts` refers to this
 * module, the class below is declared to extend that type, so that its instances can be
 * stored in `Effect#b`.
 * TODO remove this and the interface below once `types.ts` is svelte-lite's own
 */
type DeclaredBoundary = NonNullable<Effect['b']>;

export interface Boundary extends DeclaredBoundary {}

export class Boundary {
	parent: Boundary | null;

	is_pending = false;

	/**
	 * API-level transformError transform function. Transforms errors before they reach the `failed` snippet.
	 * Inherited from parent boundary, or defaults to identity.
	 */
	transform_error: (error: unknown) => unknown;

	#anchor: TemplateNode;

	#hydrate_open: TemplateNode | null = hydrating ? hydrate_node : null;

	#props: BoundaryProps;

	#children: (anchor: Node) => void;

	#effect: Effect;

	#main_effect: Effect | null = null;

	#pending_effect: Effect | null = null;

	#failed_effect: Effect | null = null;

	#offscreen_fragment: DocumentFragment | null = null;

	#local_pending_count = 0;
	#pending_count_update_queued = false;

	/**
	 * User effects created inside this boundary. They will run when the boundary is revealed
	 */
	#effects: Effect[] = [];

	/**
	 * Async effects that are currently in flight, grouped by the batch that started them.
	 * A speculative fork's work must not hold up the real world's boundary.
	 */
	#pending = new Map<Batch, Map<Effect, number>>();

	/**
	 * A source containing the number of pending async deriveds/expressions.
	 * Only created if `$effect.pending()` is used inside the boundary,
	 * otherwise updating the source results in needless `Batch.ensure()`
	 * calls followed by no-op flushes
	 */
	#effect_pending: Source<number> | null = null;

	#effect_pending_subscriber = createSubscriber(() => {
		this.#effect_pending = source(this.#local_pending_count);

		if (DEV) {
			tag(this.#effect_pending, '$effect.pending()');
		}

		return () => {
			this.#effect_pending = null;
		};
	});

	constructor(
		node: TemplateNode,
		props: BoundaryProps,
		children: (anchor: Node) => void,
		transform_error?: (error: unknown) => unknown
	) {
		this.#anchor = node;
		this.#props = props;

		this.#children = (anchor) => {
			var effect = active_effect as Effect;

			effect.b = this;
			effect.f |= BOUNDARY_EFFECT;

			children(anchor);
		};

		this.parent = (active_effect as Effect).b as Boundary | null;

		// Inherit transform_error from parent boundary, or use the provided one, or default to identity
		this.transform_error = transform_error ?? this.parent?.transform_error ?? ((e) => e);

		this.#effect = block(() => {
			if (hydrating) {
				const comment_data = read_hydration_instruction(this.#hydrate_open as TemplateNode);
				hydrate_next();

				const server_rendered_pending = comment_data === HYDRATION_START_ELSE;
				const server_rendered_failed = comment_data.startsWith(HYDRATION_START_FAILED);

				if (server_rendered_failed) {
					// Server rendered the failed snippet - hydrate it.
					// The serialized error is embedded in the comment: <!--[?<json>-->
					const serialized_error = JSON.parse(comment_data.slice(HYDRATION_START_FAILED.length));
					this.#hydrate_failed_content(serialized_error);
				} else if (server_rendered_pending) {
					this.#hydrate_pending_content();
				} else {
					this.#hydrate_resolved_content();
				}
			} else {
				this.#render();
			}
		}, flags);

		if (hydrating) {
			this.#anchor = hydrate_node;
		}
	}

	#hydrate_resolved_content(): void {
		try {
			this.#main_effect = branch(() => this.#children(this.#anchor));
		} catch (error) {
			this.error(error);
		}
	}

	/**
	 * @param error The deserialized error from the server's hydration comment
	 */
	#hydrate_failed_content(error: unknown): void {
		const failed = this.#props.failed;
		const { reset, invoke_onerror } = this.#create_reset(error);

		// `onerror` may mutate state, which is disallowed while hydrating
		queue_micro_task(invoke_onerror);

		if (!failed) return;

		this.#failed_effect = branch(() => {
			failed(
				this.#anchor,
				() => error,
				() => reset
			);
		});
	}

	/**
	 * Creates the `reset` function for a failed boundary, along with a function
	 * that invokes `onerror` with it (if provided)
	 */
	#create_reset(error: unknown): { reset: () => void; invoke_onerror: () => void } {
		var did_reset = false;
		var calling_on_error = false;

		const reset = () => {
			if (this.#is_destroyed()) return;

			if (did_reset) {
				w.svelte_boundary_reset_noop();
				return;
			}

			did_reset = true;

			if (calling_on_error) {
				e.svelte_boundary_reset_onerror();
			}

			if (this.#failed_effect !== null) {
				pause_effect(this.#failed_effect, () => {
					this.#failed_effect = null;
				});
			}

			this.#run(() => {
				this.#render();
			});
		};

		const invoke_onerror = () => {
			if (this.#is_destroyed()) return;

			try {
				calling_on_error = true;
				this.#props.onerror?.(error, reset);
				calling_on_error = false;
			} catch (err) {
				invoke_error_boundary(err, this.#effect && this.#effect.parent);
			}
		};

		return { reset, invoke_onerror };
	}

	#is_destroyed(): boolean {
		return (this.#effect.f & (DESTROYED | DESTROYING)) !== 0;
	}

	#hydrate_pending_content(): void {
		const pending = this.#props.pending;
		if (!pending) return;

		this.is_pending = true;
		this.#pending_effect = branch(() => pending(this.#anchor));

		queue_micro_task(() => {
			if (this.#is_destroyed()) return;

			var fragment = (this.#offscreen_fragment = create_fragment());
			var anchor = create_text();

			fragment.append(anchor);

			this.#main_effect = this.#run(() => {
				try {
					return branch(() => this.#children(anchor));
				} catch (error) {
					try {
						this.error(error);
					} catch (error) {
						invoke_error_boundary(error, this.#effect.parent);
					}

					return null;
				}
			});

			if (this.#main_effect !== null && this.#pending.size === 0) {
				this.is_pending = false;
				this.#anchor.before(fragment);
				this.#offscreen_fragment = null;

				pause_effect(this.#pending_effect as Effect, () => {
					this.#pending_effect = null;
				});
			}
		});
	}

	#render(): void {
		try {
			this.is_pending = this.has_pending_snippet();
			this.#local_pending_count = 0;

			this.#main_effect = branch(() => {
				this.#children(this.#anchor);
			});

			if (this.#pending.size === 0) {
				this.is_pending = false;
			} else {
				const pending = this.#props.pending;

				if (pending) {
					var fragment = (this.#offscreen_fragment = create_fragment());
					move_effect(this.#main_effect, fragment);

					this.#pending_effect = branch(() => pending(this.#anchor));
				}
			}
		} catch (error) {
			this.error(error);
		}
	}

	/**
	 * Defer an effect inside a pending boundary until the boundary resolves
	 */
	defer_effect(effect: Effect): void {
		this.#effects.push(effect);
	}

	has_pending_snippet(): boolean {
		return !!this.#props.pending;
	}

	#run<T>(fn: () => T): T {
		var previous_effect = active_effect;
		var previous_reaction = active_reaction;
		var previous_ctx = component_context;

		set_active_effect(this.#effect);
		set_active_reaction(this.#effect);
		set_component_context(this.#effect.ctx);

		try {
			Batch.ensure();
			return fn();
		} finally {
			set_active_effect(previous_effect);
			set_active_reaction(previous_reaction);
			set_component_context(previous_ctx);
		}
	}

	is_ready(batch: Batch): boolean {
		if (batch.is_fork && this.#pending.size > 0) {
			return false;
		}

		for (const [owner, pending] of this.#pending) {
			if (owner.is_fork) continue;

			for (const effect of pending.keys()) {
				if (batch.is_blocked_by(effect, this.#main_effect)) {
					return false;
				}
			}
		}

		return true;
	}

	reveal(effects: Effect[]): void {
		this.is_pending = false;

		// Add any deferred effects to the batch's effect queue
		for (const effect of this.#effects) {
			set_signal_status(effect, DIRTY);
			effects.push(effect);
		}

		this.#effects.length = 0;

		if (this.#pending_effect) {
			pause_effect(this.#pending_effect, () => {
				this.#pending_effect = null;
			});
		}

		if (this.#offscreen_fragment) {
			this.#anchor.before(this.#offscreen_fragment);
			this.#offscreen_fragment = null;
		}
	}

	increment(effect: Effect, batch: Batch): void {
		var pending = this.#pending.get(batch);

		if (pending === undefined) {
			this.#pending.set(batch, (pending = new Map()));
		}

		var count = pending.get(effect) ?? 0;
		pending.set(effect, count + 1);
	}

	decrement(effect: Effect, batch: Batch): void {
		var pending = this.#pending.get(batch) as Map<Effect, number>;
		var count = pending.get(effect) as number;

		if (count === 1) {
			pending.delete(effect);

			if (pending.size === 0) {
				this.#pending.delete(batch);
			}

			// The remaining work may belong to speculative forks. Check again in a normal batch,
			// after the result's batch has flushed, so that we reveal committed content and run
			// deferred effects in the same view.
			queue_micro_task(() => {
				if (this.is_pending && !this.#is_destroyed()) {
					Batch.ensure().schedule(this.#effect, MAYBE_DIRTY);
				}
			});
		} else {
			pending.set(effect, count - 1);
		}
	}

	/**
	 * Update the source that powers `$effect.pending()` inside this boundary.
	 * Do not call from inside the class
	 */
	update_effect_pending(d: 1 | -1): void {
		this.#local_pending_count += d;

		if (!this.#effect_pending || this.#pending_count_update_queued) return;
		this.#pending_count_update_queued = true;

		queue_micro_task(() => {
			this.#pending_count_update_queued = false;
			if (this.#effect_pending) {
				internal_set(this.#effect_pending, this.#local_pending_count);
			}
		});
	}

	get_effect_pending(): number {
		this.#effect_pending_subscriber();
		return get(this.#effect_pending as Source<number>);
	}

	error(error: unknown): void {
		if (error === HYDRATION_ERROR) {
			throw error;
		}

		// If we have nothing to capture the error, or if we hit an error while
		// rendering the fallback, re-throw for another boundary to handle
		if (!this.#props.onerror && !this.#props.failed) {
			throw error;
		}

		if (current_batch?.is_fork) {
			if (this.#main_effect) current_batch.skip_effect(this.#main_effect);
			if (this.#pending_effect) current_batch.skip_effect(this.#pending_effect);
			if (this.#failed_effect) current_batch.skip_effect(this.#failed_effect);

			current_batch.oncommit(() => {
				if (!this.#is_destroyed()) this.#handle_error(error);
			});
		} else {
			this.#handle_error(error);
		}
	}

	#handle_error(error: unknown): void {
		if (this.#main_effect) {
			destroy_effect(this.#main_effect);
			this.#main_effect = null;
		}

		if (this.#pending_effect) {
			destroy_effect(this.#pending_effect);
			this.#pending_effect = null;
		}

		if (this.#failed_effect) {
			destroy_effect(this.#failed_effect);
			this.#failed_effect = null;
		}

		if (hydrating) {
			set_hydrate_node(this.#hydrate_open as TemplateNode);
			next();
			set_hydrate_node(skip_nodes());
		}

		let failed = this.#props.failed;

		const handle_error_result = (transformed_error: unknown) => {
			if (this.#is_destroyed()) return;

			const { reset, invoke_onerror } = this.#create_reset(transformed_error);

			invoke_onerror();

			if (failed && !this.#is_destroyed()) {
				this.#failed_effect = this.#run(() => {
					try {
						return branch(() => {
							// errors in `failed` snippets cause the boundary to error again
							// TODO Svelte 6: revisit this decision, most likely better to go to parent boundary instead
							var effect = active_effect as Effect;

							effect.b = this;
							effect.f |= BOUNDARY_EFFECT;

							failed(
								this.#anchor,
								() => transformed_error,
								() => reset
							);
						});
					} catch (error) {
						invoke_error_boundary(error, this.#effect.parent);
						return null;
					}
				});
			}
		};

		queue_micro_task(() => {
			if (this.#is_destroyed()) return;

			// Run the error through the API-level transformError transform (e.g. SvelteKit's handleError)
			var result: unknown;
			try {
				result = this.transform_error(error);
			} catch (e) {
				invoke_error_boundary(e, this.#effect && this.#effect.parent);
				return;
			}

			if (
				result !== null &&
				typeof result === 'object' &&
				typeof (result as any).then === 'function'
			) {
				// transformError returned a Promise — wait for it
				(result as any).then(handle_error_result, (e: unknown) =>
					invoke_error_boundary(e, this.#effect && this.#effect.parent)
				);
			} else {
				// Synchronous result — handle immediately
				handle_error_result(result);
			}
		});
	}
}

export function pending(): number {
	if (active_effect === null) {
		e.effect_pending_outside_reaction();
	}

	var boundary = (active_effect as Effect).b;

	if (boundary === null) {
		return 0; // TODO eventually we will need this to be global
	}

	return boundary.get_effect_pending();
}
