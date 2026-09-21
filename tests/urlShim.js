// A `URL` good enough for the companion's rules under gjs.
//
// rules.js ships inside a WebExtension, where `URL` is a browser global, so
// the module is written against it directly. gjs 1.88 has no `URL` global at
// all, and rules.js treats a failed parse as "not a web page", so without a
// shim every https URL in the test suite would quietly report empty rather
// than fail loudly. This installs one over GLib.Uri, which is a real RFC 3986
// parser, and exposes only the three members rules.js reads.
//
// Test support only. Nothing under companion/ or src/ imports this.

import GLib from 'gi://GLib';

// ENCODED leaves %-escapes in the path alone, so decoding stays rules.js's
// job (and a malformed escape survives to be kept raw). PARSE_RELAXED accepts
// an invalid escape instead of rejecting the whole URL, which is what a
// browser's URL does.
const FLAGS = GLib.UriFlags.ENCODED | GLib.UriFlags.PARSE_RELAXED;

class ShimURL {
    constructor(urlString) {
        let uri;
        try {
            uri = GLib.Uri.parse(String(urlString), FLAGS);
        } catch {
            // WHATWG URL rejects an unparsable string with a TypeError.
            throw new TypeError(`Invalid URL: ${urlString}`);
        }
        this.protocol = `${uri.get_scheme()}:`;
        this.hostname = uri.get_host() ?? '';
        this.pathname = uri.get_path();
    }
}

export function installURLShim() {
    if (typeof globalThis.URL === 'undefined')
        globalThis.URL = ShimURL;
}
