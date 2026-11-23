import { run_all } from '../../shared/utils.ts';
import { is_flushing_sync } from '../reactivity/batch.ts';

let micro_tasks: Array<() => void> = [];

function run_micro_tasks(): void {
	var tasks = micro_tasks;
	micro_tasks = [];
	run_all(tasks);
}

export function queue_micro_task(fn: () => void): void {
	if (micro_tasks.length === 0 && !is_flushing_sync) {
		var tasks = micro_tasks;
		queueMicrotask(() => {
			// If this is false, a flushSync happened in the meantime. Do _not_ run new scheduled microtasks in that case
			// as the ordering of microtasks would be broken at that point - consider this case:
			// - queue_micro_task schedules microtask A to flush task X
			// - synchronously after, flushSync runs, processing task X
			// - synchronously after, some other microtask B is scheduled, but not through queue_micro_task but for example a Promise.resolve() in user code
			// - synchronously after, queue_micro_task schedules microtask C to flush task Y
			// - one tick later, microtask A now resolves, flushing task Y before microtask B, which is incorrect
			// This if check prevents that race condition (that realistically will only happen in tests)
			if (tasks === micro_tasks) run_micro_tasks();
		});
	}

	micro_tasks.push(fn);
}

/**
 * Synchronously run any queued tasks.
 */
export function flush_tasks(): void {
	while (micro_tasks.length > 0) {
		run_micro_tasks();
	}
}
