import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { test, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import { IntervalLog, INTERVAL_DIR } from '../src/intervalLog.js';
import { evidenceFor } from '../src/evidence.js';

function at(y, mo, d, h, mi = 0) {
    return GLib.DateTime.new_local(y, mo, d, h, mi, 0).to_unix() * 1000;
}

function freshLog(settings = new FakeSettings()) {
    let dir = Gio.File.new_for_path(INTERVAL_DIR);
    if (dir.query_exists(null)) {
        let e = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = e.next_file(null)) !== null)
            dir.get_child(info.get_name()).delete(null);
        e.close(null);
    }
    return new IntervalLog(settings);
}

function session(startMs, endMs) {
    return { id: 'x', client: 'ACME', startMs, endMs, dayKey: '2026-09-11' };
}

test('evidenceFor: fully covered session has no unattributed time', () => {
    let log = freshLog();
    let t = at(2026, 9, 11, 9, 0);
    log.record(t, t + 3600000, ['kgx', 'claude', 'lab'], ['Console', 'claude', 'lab']);
    log.flushAll();
    let ev = evidenceFor(session(t, t + 3600000), log);
    assertEqual(ev.spanSeconds, 3600);
    assertEqual(ev.trackedSeconds, 3600);
    assertEqual(ev.unattributedSeconds, 0);
    assertEqual(ev.entries.map(e => [e.appId, e.seconds]), [['kgx', 3600]]);
    log.destroy();
});

test('evidenceFor: a gap in the intervals becomes unattributed time', () => {
    let log = freshLog();
    let t = at(2026, 9, 11, 9, 0);
    log.record(t, t + 600000, ['kgx'], ['Console']);
    log.record(t + 3000000, t + 3600000, ['kgx'], ['Console']);
    log.flushAll();
    let ev = evidenceFor(session(t, t + 3600000), log);
    assertEqual(ev.spanSeconds, 3600);
    assertEqual(ev.trackedSeconds, 1200);
    assertEqual(ev.unattributedSeconds, 2400, 'the 40 minutes away');
    log.destroy();
});

test('evidenceFor: intervals outside the session do not leak in', () => {
    let log = freshLog();
    let t = at(2026, 9, 11, 9, 0);
    log.record(t - 3600000, t, ['zen'], ['Zen']);
    log.record(t, t + 1800000, ['kgx'], ['Console']);
    log.flushAll();
    let ev = evidenceFor(session(t, t + 1800000), log);
    assertEqual(ev.entries.map(e => e.appId), ['kgx'], 'the hour before belongs to nobody here');
    log.destroy();
});

test('evidenceFor: a session with nothing tracked is wholly unattributed', () => {
    let log = freshLog();
    let t = at(2026, 9, 11, 9, 0);
    let ev = evidenceFor(session(t, t + 1800000), log);
    assertEqual(ev.trackedSeconds, 0);
    assertEqual(ev.unattributedSeconds, 1800);
    assertEqual(ev.entries, []);
    log.destroy();
});

test('evidenceFor: a running session measures up to now', () => {
    let log = freshLog();
    let t = at(2026, 9, 11, 9, 0);
    log.record(t, t + 600000, ['kgx'], ['Console']);
    log.flushAll();
    let ev = evidenceFor(session(t, null), log, t + 900000);
    assertEqual(ev.spanSeconds, 900);
    assertEqual(ev.trackedSeconds, 600);
    assertEqual(ev.unattributedSeconds, 300);
    log.destroy();
});

// IntervalLog.query() rounds bottom-up: every node's `seconds` is rounded
// independently, so a session whose intervals fully cover its span can still
// report a `trackedSeconds` a second or two above `spanSeconds` once several
// fractional clips each round up. unattributedSeconds must stay clamped at 0
// rather than going negative.
test('evidenceFor: a fully covered session with fractional clips never dips negative', () => {
    let log = freshLog();
    let t = at(2026, 9, 11, 9, 0);
    log.record(t, t + 1000, ['a'], ['A']);
    log.record(t + 1000, t + 2000, ['b'], ['B']);
    log.record(t + 2000, t + 3000, ['c'], ['C']);
    log.record(t + 3000, t + 4000, ['d'], ['D']);
    log.flushAll();
    // The session's span (3000ms) exactly equals the raw tracked time within
    // it (500 + 1000 + 1000 + 500ms) - fully covered - but clipping 'a' and
    // 'd' to 0.5s each rounds each of the four nodes up independently.
    let ev = evidenceFor(session(t + 500, t + 3500), log);
    assertEqual(ev.spanSeconds, 3);
    assertEqual(ev.trackedSeconds, 4, 'four nodes each round their fractional clip up to 1s');
    assertEqual(ev.unattributedSeconds, 0, 'clamped rather than negative');
    log.destroy();
});
