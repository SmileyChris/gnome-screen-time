import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// A resolve slower than the flush tick leaves a short app-only record wedged
// between two identical fuller ones (usageTracker._applySubPath banks against
// the app path before switching). Anything this short between identical
// neighbours is that artefact, not real time at the app level.
export const STUB_MS = 2000;

function samePath(a, b) {
    return a.join('\0') === b.join('\0');
}

// True when `short` is a strict prefix of `long`: ['kgx'] of ['kgx','claude'].
function isPrefix(short, long) {
    if (short.length >= long.length)
        return false;
    return short.every((id, i) => id === long[i]);
}

// Appends `rec` to `buf`, merging where the record is really a continuation
// of what is already there. Mutates and returns `buf`.
export function pushInterval(buf, rec) {
    let last = buf[buf.length - 1];

    if (last && samePath(last.path, rec.path) && last.e === rec.s) {
        last.e = rec.e;
        return buf;
    }

    let prev = buf[buf.length - 2];
    if (last && prev &&
        last.e - last.s < STUB_MS &&
        samePath(prev.path, rec.path) &&
        isPrefix(last.path, prev.path) &&
        prev.e === last.s && last.e === rec.s) {
        prev.e = rec.e;
        buf.pop();
        return buf;
    }

    buf.push(rec);
    return buf;
}
