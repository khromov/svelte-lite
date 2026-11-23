import { listen } from './shared.ts';

export function bind_online(update: (online: boolean) => void): void {
	listen(window, ['online', 'offline'], () => {
		update(navigator.onLine);
	});
}
