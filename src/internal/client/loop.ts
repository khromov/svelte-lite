import type { Task, TaskCallback, TaskEntry } from './types.ts';
import { raf } from './timing.ts';

function run_tasks(): void {
	// use `raf.now()` instead of the `requestAnimationFrame` callback argument, because
	// otherwise things can get wonky https://github.com/sveltejs/svelte/pull/14541
	const now = raf.now();

	raf.tasks.forEach((task) => {
		if (!task.c(now)) {
			raf.tasks.delete(task);
			task.f();
		}
	});

	if (raf.tasks.size !== 0) {
		raf.tick(run_tasks);
	}
}

/**
 * Creates a new task that runs on each raf frame
 * until it returns a falsy value or is aborted
 */
export function loop(callback: TaskCallback): Task {
	let task: TaskEntry;

	if (raf.tasks.size === 0) {
		raf.tick(run_tasks);
	}

	return {
		promise: new Promise((fulfill) => {
			raf.tasks.add((task = { c: callback, f: fulfill }));
		}),
		abort() {
			raf.tasks.delete(task);
		}
	};
}
