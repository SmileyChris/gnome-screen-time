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
