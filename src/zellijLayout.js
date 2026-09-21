// Pure parsers for zellij state. No Gio or Shell imports so this runs under
// plain gjs in the test suite.

// A zellij client titles its window "<session> | <focused pane title>". The
// pane title is set by the innermost program and carries work content, so
// only the session token is read and nothing else from the title is kept.
const SESSION_RE = /^(.+?) \| /;

export function sessionFromTitle(title) {
    if (typeof title !== 'string')
        return null;
    let m = SESSION_RE.exec(title);
    return m ? m[1] : null;
}

// `dump-layout` is KDL, one node per line. The focused tab and the focused
// pane inside it both carry `focus=true`. Only the focused tab's block is
// scanned, so an unfocused tab's focus marker (every tab remembers one) is
// never picked up.
const TAB_RE = /^\s*tab\b[^{]*\bfocus=true\b/;
const PANE_RE = /^\s*pane\b[^{]*\bfocus=true\b/;

// KDL string literal, with backslash escapes. Blanked before any structural
// scan so a brace or `focus=true` inside a quoted value is never mistaken
// for syntax.
const QUOTED_RE = /"(?:[^"\\]|\\.)*"/g;

function count(str, ch) {
    let n = 0;
    for (let c of str)
        if (c === ch) n++;
    return n;
}

function structural(line) {
    return line.replace(QUOTED_RE, '""');
}

// KDL string attribute, with backslash escapes collapsed.
function attr(line, name) {
    let m = new RegExp(`\\b${name}="((?:[^"\\\\]|\\\\.)*)"`).exec(line);
    return m ? m[1].replace(/\\(.)/g, '$1') : null;
}

export function focusedPane(layout) {
    if (typeof layout !== 'string')
        return null;
    let lines = layout.split('\n');
    let start = lines.findIndex(l => TAB_RE.test(structural(l)));
    if (start < 0)
        return null;

    let depth = 0;
    for (let i = start; i < lines.length; i++) {
        let line = lines[i];
        let bare = structural(line);
        if (i > start && PANE_RE.test(bare)) {
            return { command: attr(line, 'command'), cwd: attr(line, 'cwd') };
        }
        depth += count(bare, '{') - count(bare, '}');
        if (depth <= 0)
            break;   // end of the focused tab's block
    }
    return null;
}

// Last path segment. cwd in dump-layout is relative to the layout's cwd, so
// this is string work rather than a filesystem call.
export function basename(path) {
    let trimmed = path.replace(/\/+$/, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}
