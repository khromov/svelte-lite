import type {
	AnimationManager,
	ComponentContext,
	DevStackEntry,
	Equals,
	TemplateNode,
	TransitionManager
} from '../types.ts';

export interface Signal {
	/** Flags bitmask */
	f: number;
	/** Write version */
	wv: number;
}

export interface Value<V = unknown> extends Signal {
	/** Equality function */
	equals: Equals;
	/** Signals that read from this signal */
	reactions: null | Reaction[];
	/** Read version */
	rv: number;
	/** The latest value for this signal */
	v: V;

	// dev-only
	/** A label (e.g. the `foo` in `let foo = $state(...)`) used for `$inspect.trace()` */
	label?: string;
	/** An error with a stack trace showing when the source was created */
	created?: Error | null;
	/** An map of errors with stack traces showing when the source was updated, keyed by the stack trace */
	updated?: Map<string, { error: Error; count: number }> | null;
	/**
	 * Whether or not the source was set while running an effect — if so, we need to
	 * increment the write version so that it shows up as dirty when the effect re-runs
	 */
	set_during_effect?: boolean;
	/** A function that retrieves the underlying source, used for each block item signals */
	trace?: null | (() => void);
}

export interface Reaction extends Signal {
	/** The associated component context */
	ctx: null | ComponentContext;
	/** The reaction function */
	fn: null | Function;
	/** Signals that this signal reads from */
	deps: null | Value[];
	/**
	 * The controller of the signal that `getAbortSignal()` returned to the last run, if it was called.
	 * It aborts once the reaction runs again or is destroyed. Only set by `getAbortSignal()`
	 */
	ac?: null | AbortController;
}

export interface Derived<V = unknown> extends Value<V>, Reaction {
	/** The derived function */
	fn: () => V;
	/** Effects created inside this signal. Used to destroy those effects when the derived reruns or is cleaned up */
	effects: null | Effect[];
	/** The write version of the last write that the derived was marked for (see `mark_reactions`) */
	mv: number;
	/** Parent effect */
	parent: Effect | null;
}

export interface EffectNodes {
	start: TemplateNode;
	end: TemplateNode | null;
	/** $.animation */
	a: AnimationManager | null;
	/** $.transition */
	t: TransitionManager[] | null;
}

/**
 * What an effect knows of the `<svelte:boundary>` whose content it is the root of
 */
export interface Boundary {
	/**
	 * Hands the boundary an error from inside it, which it throws if it has nothing to handle it with.
	 * Missing on what `mount` puts at the root of an app, which only carries `transform_error`
	 */
	error?: (error: unknown) => void;
	/** The `transformError` option of `mount` and `hydrate`, which applies to every boundary of the app */
	transform_error?: (error: unknown) => unknown;
}

export interface Effect extends Reaction {
	/**
	 * Branch effects store their start/end nodes so that they can be
	 * removed when the effect is destroyed, or moved when an `each`
	 * block is reconciled. In the case of a single text/element node,
	 * `start` and `end` will be the same.
	 */
	nodes: null | EffectNodes;
	/** The effect function */
	fn: null | (() => void | (() => void));
	/** The teardown function returned from the effect function */
	teardown: null | (() => void);
	/** Next sibling child effect created inside the parent signal */
	prev: null | Effect;
	/** Next sibling child effect created inside the parent signal */
	next: null | Effect;
	/** First child effect created inside this signal */
	first: null | Effect;
	/** Last child effect created inside this signal */
	last: null | Effect;
	/** Parent effect */
	parent: Effect | null;
	/**
	 * The boundary whose content this effect is the root of, or what `mount` leaves
	 * on the root effect for the boundaries of the app (see `Boundary`)
	 */
	b?: Boundary;
	/** Dev only */
	component_function?: any;
	/** Dev only. Only set for certain block effects. Contains a reference to the stack that represents the render tree */
	dev_stack?: DevStackEntry | null;
}

export type Source<V = unknown> = Value<V>;

export type MaybeSource<T = unknown> = T | Source<T>;
