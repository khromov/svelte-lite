import type { Derived, Signal } from '../types.ts';
import { CLEAN, CONNECTED, DIRTY, MAYBE_DIRTY } from '../constants.ts';

const STATUS_MASK = ~(DIRTY | MAYBE_DIRTY | CLEAN);

export function set_signal_status(signal: Signal, status: number): void {
	signal.f = (signal.f & STATUS_MASK) | status;
}

/**
 * Set a derived's status to CLEAN or MAYBE_DIRTY based on its connection state.
 */
export function update_derived_status(derived: Derived): void {
	// Only mark as MAYBE_DIRTY if disconnected and has dependencies.
	if ((derived.f & CONNECTED) !== 0 || derived.edges === null) {
		set_signal_status(derived, CLEAN);
	} else {
		set_signal_status(derived, MAYBE_DIRTY);
	}
}
