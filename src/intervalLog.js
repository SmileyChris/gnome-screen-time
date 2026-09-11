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

import { dateKey } from './usageStore.js';

const INTERVAL_SUBDIR = 'intervals';
export const INTERVAL_DIR = GLib.build_filenamev([
    GLib.get_user_data_dir(), 'gnome-shell', 'screen-time', INTERVAL_SUBDIR
]);

// The last two buffered records are held back: the newest may still be
// extended by the next emit, and the one before it may still absorb a stub.
const TAIL_HELD = 2;

// One JSON array per line. Trailing nulls are dropped so an app-only record
// is four elements rather than eight.
function encodeLine(rec) {
    let row = [rec.s, rec.e];
    for (let i = 0; i < 3; i++)
        row.push(rec.path[i] ?? null, rec.names[i] ?? null);
    while (row.length > 4 && row[row.length - 1] === null)
        row.pop();
    return `${JSON.stringify(row)}\n`;
}

function decodeLine(row) {
    let path = [];
    let names = [];
    for (let i = 2; i < row.length; i += 2) {
        if (row[i] === null || row[i] === undefined)
            break;
        path.push(row[i]);
        names.push(row[i + 1] ?? row[i]);
    }
    return { s: row[0], e: row[1], path, names };
}

export class IntervalLog {
    constructor(settings) {
        this._settings = settings;
        this._buf = [];
        this._ensureDir();
    }

    _ensureDir() {
        let dir = Gio.File.new_for_path(INTERVAL_DIR);
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
    }

    _dayStartHour() {
        return this._settings.get_int('day-start-hour');
    }

    _keyFor(ms) {
        return dateKey(GLib.DateTime.new_from_unix_local(ms / 1000), this._dayStartHour());
    }

    _fileFor(key) {
        return Gio.File.new_for_path(GLib.build_filenamev([INTERVAL_DIR, `${key}.ndjson`]));
    }

    record(startMs, endMs, path, names) {
        if (endMs <= startMs)
            return;
        pushInterval(this._buf, {
            s: startMs, e: endMs, path: [...path], names: [...names],
        });
    }

    // Writes everything except the tail that may still merge.
    flush() {
        this._writeOut(Math.max(0, this._buf.length - TAIL_HELD));
    }

    flushAll() {
        this._writeOut(this._buf.length);
    }

    // Appends `count` records from the front of the buffer, grouped by day
    // file so a run of records costs one append per file, not one per record.
    _writeOut(count) {
        if (count <= 0)
            return;
        let batch = this._buf.splice(0, count);
        let byDay = new Map();
        for (let rec of batch) {
            let key = this._keyFor(rec.s);
            byDay.set(key, (byDay.get(key) ?? '') + encodeLine(rec));
        }
        for (let [key, text] of byDay) {
            try {
                let stream = this._fileFor(key).append_to(
                    Gio.FileCreateFlags.NONE, null);
                stream.write_all(new TextEncoder().encode(text), null);
                stream.close(null);
            } catch (e) {
                console.error(`[ScreenTime] interval append failed: ${e.message}`);
            }
        }
    }

    // Every stored record overlapping [fromMs, toMs], clipped to it, folded
    // into the same tree shape UsageStore.getUsageForDate returns.
    query(fromMs, toMs) {
        let root = {};
        let total = 0;
        for (let key of this._keysInRange(fromMs, toMs)) {
            for (let row of this._readDay(key)) {
                let rec = decodeLine(row);
                let s = Math.max(rec.s, fromMs);
                let e = Math.min(rec.e, toMs);
                if (e <= s)
                    continue;
                let secs = (e - s) / 1000;
                total += secs;
                this._credit(root, rec, secs);
            }
        }
        // Clipping produces fractional seconds; round once the whole tree is
        // built so a parent still reads as the sum of what is under it.
        roundNodes(root);
        let entries = Object.entries(root)
            .map(([appId, node]) => ({
                appId,
                displayName: node.displayName,
                seconds: node.seconds,
                children: node.children ?? null,
            }))
            .sort((a, b) => b.seconds - a.seconds);
        return { seconds: Math.round(total), entries };
    }

    _credit(root, rec, secs) {
        let siblings = root;
        for (let i = 0; i < rec.path.length; i++) {
            let id = rec.path[i];
            let node = siblings[id];
            if (!node)
                node = siblings[id] = { displayName: rec.names[i], seconds: 0 };
            node.seconds += secs;
            node.displayName = rec.names[i];
            if (i < rec.path.length - 1) {
                node.children ??= {};
                siblings = node.children;
            }
        }
    }

    // Logical day keys are contiguous, so walking calendar days from the
    // start key to the end key covers every file that can hold a match.
    _keysInRange(fromMs, toMs) {
        let keys = [];
        let cursor = GLib.DateTime.new_from_unix_local(fromMs / 1000);
        let last = this._keyFor(toMs);
        let key = this._keyFor(fromMs);
        keys.push(key);
        while (key < last) {
            cursor = cursor.add_days(1);
            key = dateKey(cursor, this._dayStartHour());
            keys.push(key);
        }
        return keys;
    }

    _readDay(key) {
        let file = this._fileFor(key);
        if (!file.query_exists(null))
            return [];
        try {
            let [, contents] = file.load_contents(null);
            return new TextDecoder().decode(contents)
                .split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
        } catch (e) {
            console.error(`[ScreenTime] interval read failed for ${key}: ${e.message}`);
            return [];
        }
    }

    purge() {
        let days = this._settings.get_int('interval-retention-days');
        if (days <= 0)
            return;
        let cutoff = dateKey(
            GLib.DateTime.new_now_local().add_days(-days), this._dayStartHour());
        let dir = Gio.File.new_for_path(INTERVAL_DIR);
        let enumerator = dir.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            let name = info.get_name();
            if (!name.endsWith('.ndjson'))
                continue;
            if (name.slice(0, -'.ndjson'.length) < cutoff) {
                try {
                    dir.get_child(name).delete(null);
                } catch (e) {
                    console.error(`[ScreenTime] interval purge failed: ${e.message}`);
                }
            }
        }
        enumerator.close(null);
    }

    destroy() {
        this.flushAll();
        this._settings = null;
    }
}

// Rounds every node in a `{ id: { seconds, children } }` tree, in place.
function roundNodes(siblings) {
    for (let node of Object.values(siblings)) {
        node.seconds = Math.round(node.seconds);
        if (node.children)
            roundNodes(node.children);
    }
}
