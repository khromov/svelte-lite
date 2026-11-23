var all_styles = new Map<string, Set<HTMLStyleElement>>();

export function register_style(hash: string, style: HTMLStyleElement): void {
	var styles = all_styles.get(hash);

	if (!styles) {
		styles = new Set();
		all_styles.set(hash, styles);
	}

	styles.add(style);
}

export function cleanup_styles(hash: string): void {
	var styles = all_styles.get(hash);
	if (!styles) return;

	for (const style of styles) {
		style.remove();
	}

	all_styles.delete(hash);
}
