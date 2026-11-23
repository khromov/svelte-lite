// Stands in for upstream src/internal/client/constants.js

// The suite's own helpers (tests/html_equal.js, tests/runtime-browser/assert.js) use
// these to normalise HTML before comparing it. They are the DOM's `Node.nodeType`
// values, and have to be right for any comparison of markup to mean something.
export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;
export const COMMENT_NODE = 8;
