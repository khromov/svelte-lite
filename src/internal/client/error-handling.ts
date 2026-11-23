import type { Effect } from './types.ts';
import { DEV } from 'esm-env';
import { FILENAME, HYDRATION_ERROR } from '../../constants.ts';
import { is_firefox } from './dom/operations.ts';
import { BOUNDARY_EFFECT, REACTION_RAN, EFFECT, DESTROYED, DESTROYING } from './constants.ts';
import { define_property, get_descriptor } from '../shared/utils.ts';
import { active_effect } from './runtime.ts';

type Adjustments = { message: string; stack: string | undefined } | undefined;

const adjustments = new WeakMap<Error, Adjustments>();

export function handle_error(error: unknown): unknown {
	var effect = active_effect;

	// for unowned deriveds, don't throw until we read the value (the error becomes their value)
	if (effect === null) {
		return error;
	}

	if (DEV && error instanceof Error && !adjustments.has(error)) {
		adjustments.set(error, get_adjustments(error, effect));
	}

	// if the error occurred while creating this subtree, we let it
	// bubble up until it hits a boundary that can handle it, unless
	// it's an $effect in which case it doesn't run immediately
	if ((effect.f & REACTION_RAN) === 0 && (effect.f & EFFECT) === 0) {
		if (DEV && !effect.parent && error instanceof Error) {
			apply_adjustments(error);
		}

		throw error;
	}

	// otherwise we bubble up the effect tree ourselves
	invoke_error_boundary(error, effect);
}

export function invoke_error_boundary(error: unknown, effect: Effect | null): void {
	if (error === HYDRATION_ERROR) {
		throw error;
	}

	if (effect !== null && (effect.f & DESTROYED) !== 0) {
		return;
	}

	while (effect !== null) {
		// Skip boundaries that are destroyed/destroying and cannot meaningfully handle the error.
		if ((effect.f & BOUNDARY_EFFECT) !== 0 && (effect.f & (DESTROYED | DESTROYING)) === 0) {
			if ((effect.f & REACTION_RAN) === 0) {
				// we are still creating the boundary effect
				throw error;
			}

			try {
				effect.b!.error(error);
				return;
			} catch (e) {
				error = e;
			}
		}

		effect = effect.parent;
	}

	if (DEV && error instanceof Error) {
		apply_adjustments(error);
	}

	throw error;
}

/**
 * Matches a stack frame of a function in this module, which is `internal/client/error-handling.ts`,
 * and captures the path of `internal/`. V8 puts the path in parentheses, other engines after an `@`
 */
const OWN_FRAME = /[(@](.*\/internal\/)client\/error-handling\./;

/**
 * Add useful information to the error message/stack in development
 */
function get_adjustments(error: Error, effect: Effect): Adjustments {
	const message_descriptor = get_descriptor(error, 'message');

	// if the message was already changed and it's not configurable we can't change it
	// or it will throw a different error swallowing the original error
	if (message_descriptor && !message_descriptor.configurable) return;

	var indent = is_firefox ? '  ' : '\t';
	var component_stack = `\n${indent}in ${effect.fn?.name || '<unknown>'}`;
	var context = effect.ctx;

	while (context !== null) {
		component_stack += `\n${indent}in ${context.function?.[FILENAME].split('/').pop()}`;
		context = context.p;
	}

	// Svelte recognises its own frames by `svelte/src/internal` in their path. That holds for
	// the modules of Svelte that are in use here, but not for this package, which can be
	// installed under any name. Its location is read off the frame of this function instead
	// (see `get_stack` in `shared/dev.ts`)
	const own_frames = (new Error().stack ?? '').split('\n').slice(0, 2).join('\n');
	const internal = OWN_FRAME.exec(own_frames.replaceAll('\\', '/'))?.[1];

	return {
		message: error.message + `\n${component_stack}\n`,
		stack: error.stack
			?.split('\n')
			.filter(
				(line) =>
					!line.includes('svelte/src/internal') &&
					(internal === undefined || !line.replaceAll('\\', '/').includes(internal))
			)
			.join('\n')
	};
}

function apply_adjustments(error: Error): void {
	const adjusted = adjustments.get(error);

	if (adjusted) {
		define_property(error, 'message', {
			value: adjusted.message
		});

		define_property(error, 'stack', {
			value: adjusted.stack
		});
	}
}
