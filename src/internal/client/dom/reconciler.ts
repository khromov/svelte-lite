import { create_element } from './operations.ts';

/**
 * Svelte passes the HTML it parses through a Trusted Types policy of its own, so that it gets
 * past a `require-trusted-types-for 'script'` CSP. svelte-lite has no such policy and assigns
 * the string as it is, which under that CSP needs a `default` policy on the page. This remains
 * for the modules that call it.
 */
export function create_trusted_html(html: string): string {
	return html;
}

export function create_fragment_from_html(html: string): DocumentFragment {
	var elem = create_element('template');
	elem.innerHTML = html.replaceAll('<!>', '<!---->'); // XHTML compliance
	return elem.content;
}
