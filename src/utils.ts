// What Svelte's compiler and its two runtimes have in common. The compiler is reused from
// Svelte and loads Svelte's module, not this one, so the parts that only it needs (reserved
// words, runes and so on) have no user here. They stay so that this remains the same module.

const regex_return_characters = /\r/g;

export function hash(str: string): string {
	str = str.replace(regex_return_characters, '');
	let hash = 5381;
	let i = str.length;

	while (i--) hash = ((hash << 5) - hash) ^ str.charCodeAt(i);
	return (hash >>> 0).toString(36);
}

const VOID_ELEMENT_NAMES = [
	'area',
	'base',
	'br',
	'col',
	'command',
	'embed',
	'hr',
	'img',
	'input',
	'keygen',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr'
];

/**
 * Returns `true` if `name` is of a void element
 */
export function is_void(name: string) {
	return VOID_ELEMENT_NAMES.includes(name) || name.toLowerCase() === '!doctype';
}

const RESERVED_WORDS = [
	'arguments',
	'await',
	'break',
	'case',
	'catch',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'enum',
	'eval',
	'export',
	'extends',
	'false',
	'finally',
	'for',
	'function',
	'if',
	'implements',
	'import',
	'in',
	'instanceof',
	'interface',
	'let',
	'new',
	'null',
	'package',
	'private',
	'protected',
	'public',
	'return',
	'static',
	'super',
	'switch',
	'this',
	'throw',
	'true',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
	'yield'
];

/**
 * Returns `true` if `word` is a reserved JavaScript keyword
 */
export function is_reserved(word: string) {
	return RESERVED_WORDS.includes(word);
}

export function is_capture_event(name: string) {
	return name.endsWith('capture') && name !== 'gotpointercapture' && name !== 'lostpointercapture';
}

/**
 * Attributes that are boolean, i.e. they are present or not present.
 */
const DOM_BOOLEAN_ATTRIBUTES = [
	'allowfullscreen',
	'async',
	'autofocus',
	'autoplay',
	'checked',
	'controls',
	'default',
	'disabled',
	'formnovalidate',
	'indeterminate',
	'inert',
	'ismap',
	'loop',
	'multiple',
	'muted',
	'nomodule',
	'novalidate',
	'open',
	'playsinline',
	'readonly',
	'required',
	'reversed',
	'seamless',
	'selected',
	'webkitdirectory',
	'defer',
	'disablepictureinpicture',
	'disableremoteplayback'
];

/**
 * Returns `true` if `name` is a boolean attribute
 */
export function is_boolean_attribute(name: string) {
	return DOM_BOOLEAN_ATTRIBUTES.includes(name);
}

/**
 * The properties that an attribute name should be aliased to, because they behave
 * differently between setting them as an attribute and setting them as a property.
 * An attribute is the name of its property in lower case, so the properties are all
 * there is to list: this is in every app with a spread, where Svelte's table of both
 * costs 56 B more (gzip)
 */
const ATTRIBUTE_ALIASES = [
	// no `className` because we handle that separately
	'formNoValidate',
	'isMap',
	'noModule',
	'playsInline',
	'readOnly',
	'defaultValue',
	'defaultChecked',
	'srcObject',
	'noValidate',
	'allowFullscreen',
	'disablePictureInPicture',
	'disableRemotePlayback'
];

export function normalize_attribute(name: string) {
	name = name.toLowerCase();
	return ATTRIBUTE_ALIASES.find((alias) => alias.toLowerCase() === name) ?? name;
}

const DOM_PROPERTIES = [
	...DOM_BOOLEAN_ATTRIBUTES,
	'formNoValidate',
	'isMap',
	'noModule',
	'playsInline',
	'readOnly',
	'value',
	'volume',
	'defaultValue',
	'defaultChecked',
	'srcObject',
	'noValidate',
	'allowFullscreen',
	'disablePictureInPicture',
	'disableRemotePlayback'
];

export function is_dom_property(name: string) {
	return DOM_PROPERTIES.includes(name);
}

const NON_STATIC_PROPERTIES = ['autofocus', 'muted', 'defaultValue', 'defaultChecked'];

/**
 * Returns `true` if the given attribute cannot be set through the template
 * string, i.e. needs some kind of JavaScript handling to work.
 */
export function cannot_be_set_statically(name: string) {
	return NON_STATIC_PROPERTIES.includes(name);
}

const CONTENT_EDITABLE_BINDINGS = ['textContent', 'innerHTML', 'innerText'];

export function is_content_editable_binding(name: string) {
	return CONTENT_EDITABLE_BINDINGS.includes(name);
}

const LOAD_ERROR_ELEMENTS = [
	'body',
	'embed',
	'iframe',
	'img',
	'link',
	'object',
	'script',
	'style',
	'track'
];

/**
 * Returns `true` if the element emits `load` and `error` events
 */
export function is_load_error_element(name: string) {
	return LOAD_ERROR_ELEMENTS.includes(name);
}

const SVG_ELEMENTS = [
	'altGlyph',
	'altGlyphDef',
	'altGlyphItem',
	'animate',
	'animateColor',
	'animateMotion',
	'animateTransform',
	'circle',
	'clipPath',
	'color-profile',
	'cursor',
	'defs',
	'desc',
	'discard',
	'ellipse',
	'feBlend',
	'feColorMatrix',
	'feComponentTransfer',
	'feComposite',
	'feConvolveMatrix',
	'feDiffuseLighting',
	'feDisplacementMap',
	'feDistantLight',
	'feDropShadow',
	'feFlood',
	'feFuncA',
	'feFuncB',
	'feFuncG',
	'feFuncR',
	'feGaussianBlur',
	'feImage',
	'feMerge',
	'feMergeNode',
	'feMorphology',
	'feOffset',
	'fePointLight',
	'feSpecularLighting',
	'feSpotLight',
	'feTile',
	'feTurbulence',
	'filter',
	'font',
	'font-face',
	'font-face-format',
	'font-face-name',
	'font-face-src',
	'font-face-uri',
	'foreignObject',
	'g',
	'glyph',
	'glyphRef',
	'hatch',
	'hatchpath',
	'hkern',
	'image',
	'line',
	'linearGradient',
	'marker',
	'mask',
	'mesh',
	'meshgradient',
	'meshpatch',
	'meshrow',
	'metadata',
	'missing-glyph',
	'mpath',
	'path',
	'pattern',
	'polygon',
	'polyline',
	'radialGradient',
	'rect',
	'set',
	'solidcolor',
	'stop',
	'svg',
	'switch',
	'symbol',
	'text',
	'textPath',
	'tref',
	'tspan',
	'unknown',
	'use',
	'view',
	'vkern'
];

export function is_svg(name: string) {
	return SVG_ELEMENTS.includes(name);
}

const MATHML_ELEMENTS = [
	'annotation',
	'annotation-xml',
	'maction',
	'math',
	'merror',
	'mfrac',
	'mi',
	'mmultiscripts',
	'mn',
	'mo',
	'mover',
	'mpadded',
	'mphantom',
	'mprescripts',
	'mroot',
	'mrow',
	'ms',
	'mspace',
	'msqrt',
	'mstyle',
	'msub',
	'msubsup',
	'msup',
	'mtable',
	'mtd',
	'mtext',
	'mtr',
	'munder',
	'munderover',
	'semantics'
];

export function is_mathml(name: string) {
	return MATHML_ELEMENTS.includes(name);
}

const STATE_CREATION_RUNES = ['$state', '$state.raw', '$derived', '$derived.by'] as const;

export const RUNES = [
	...STATE_CREATION_RUNES,
	'$state.eager',
	'$state.snapshot',
	'$props',
	'$props.id',
	'$bindable',
	'$effect',
	'$effect.pre',
	'$effect.tracking',
	'$effect.root',
	'$effect.pending',
	'$inspect',
	'$inspect().with',
	'$inspect.trace',
	'$host'
] as const;

export type RuneName = (typeof RUNES)[number];

export function is_rune(name: string): name is RuneName {
	return RUNES.includes(name as RuneName);
}

export type StateCreationRuneName = (typeof STATE_CREATION_RUNES)[number];

export function is_state_creation_rune(name: string): name is StateCreationRuneName {
	return STATE_CREATION_RUNES.includes(name as StateCreationRuneName);
}

/** List of elements that require raw contents and should not have SSR comments put in them */
const RAW_TEXT_ELEMENTS = ['textarea', 'script', 'style', 'title'] as const;

export function is_raw_text_element(name: string) {
	return RAW_TEXT_ELEMENTS.includes(name as (typeof RAW_TEXT_ELEMENTS)[number]);
}

// Matches valid HTML/SVG/MathML element names and custom element names.
// https://html.spec.whatwg.org/multipage/custom-elements.html#valid-custom-element-name
//
// Standard elements: ASCII alpha start, followed by ASCII alphanumerics.
// Custom elements: ASCII alpha start, followed by any mix of PCENChar (which
// includes ASCII alphanumerics, `-`, `.`, `_`, and specified Unicode ranges),
// with at least one hyphen required somewhere after the first character.
//
// Rejects strings containing whitespace, quotes, angle brackets, slashes, equals,
// or other characters that could break out of a tag-name token and enable markup injection.
export const REGEX_VALID_TAG_NAME =
	/^[a-zA-Z][a-zA-Z0-9]*(-[a-zA-Z0-9.\-_\u00B7\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u037D\u037F-\u1FFF\u200C-\u200D\u203F-\u2040\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}]*)?$/u;

/**
 * Prevent devtools trying to make `location` a clickable link by inserting a zero-width space
 */
export function sanitize_location<T extends string | undefined>(location: T): T {
	return location?.replace(/\//g, '/\u200b') as T;
}
