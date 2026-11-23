import { create_element } from './operations.ts';

/** The part of the Trusted Types API that is used here, which TypeScript's DOM types do not have */
interface TrustedTypePolicyFactory {
	createPolicy(
		name: string,
		rules: { createHTML: (html: string) => string }
	): { createHTML(html: string): string };
}

const trusted_types = (globalThis?.window as { trustedTypes?: TrustedTypePolicyFactory } | undefined)
	?.trustedTypes;

const policy =
	// We gotta write it like this because after downleveling the pure comment may end up in the wrong location
	trusted_types &&
	/* @__PURE__ */ trusted_types.createPolicy('svelte-trusted-html', {
		createHTML: (html) => {
			return html;
		}
	});

export function create_trusted_html(html: string): string {
	return policy?.createHTML(html) ?? html;
}

export function create_fragment_from_html(html: string): DocumentFragment {
	var elem = create_element('template');
	elem.innerHTML = create_trusted_html(html.replaceAll('<!>', '<!---->')); // XHTML compliance
	return elem.content;
}
