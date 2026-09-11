import { test, assertEqual } from './harness.js';
import { pushInterval } from '../src/intervalLog.js';

const P_FULL = ['kgx', 'claude', 'lab'];
const N_FULL = ['Console', 'claude', 'lab'];
const P_APP = ['kgx'];
const N_APP = ['Console'];

test('pushInterval: first record is appended as-is', () => {
    let buf = [];
    pushInterval(buf, { s: 1000, e: 4000, path: P_FULL, names: N_FULL });
    assertEqual(buf, [{ s: 1000, e: 4000, path: P_FULL, names: N_FULL }]);
});

test('pushInterval: contiguous same path extends instead of appending', () => {
    let buf = [];
    pushInterval(buf, { s: 1000, e: 31000, path: P_FULL, names: N_FULL });
    pushInterval(buf, { s: 31000, e: 61000, path: P_FULL, names: N_FULL });
    assertEqual(buf.length, 1, 'one merged record');
    assertEqual([buf[0].s, buf[0].e], [1000, 61000]);
});

test('pushInterval: a gap with the same path does not merge', () => {
    let buf = [];
    pushInterval(buf, { s: 1000, e: 31000, path: P_FULL, names: N_FULL });
    pushInterval(buf, { s: 90000, e: 120000, path: P_FULL, names: N_FULL });
    assertEqual(buf.length, 2, 'max-interval capping leaves a real gap');
});

test('pushInterval: different path appends', () => {
    let buf = [];
    pushInterval(buf, { s: 1000, e: 31000, path: P_FULL, names: N_FULL });
    pushInterval(buf, { s: 31000, e: 61000, path: ['zen'], names: ['Zen'] });
    assertEqual(buf.length, 2);
});

test('pushInterval: sub-2s app-only stub between identical paths is absorbed', () => {
    let buf = [];
    pushInterval(buf, { s: 0, e: 30000, path: P_FULL, names: N_FULL });
    pushInterval(buf, { s: 30000, e: 31000, path: P_APP, names: N_APP });
    pushInterval(buf, { s: 31000, e: 61000, path: P_FULL, names: N_FULL });
    assertEqual(buf.length, 1, 'stub absorbed, neighbours merged');
    assertEqual([buf[0].s, buf[0].e], [0, 61000]);
    assertEqual(buf[0].path, P_FULL);
});

test('pushInterval: a long app-only interval is kept, not absorbed', () => {
    let buf = [];
    pushInterval(buf, { s: 0, e: 30000, path: P_FULL, names: N_FULL });
    pushInterval(buf, { s: 30000, e: 90000, path: P_APP, names: N_APP });
    pushInterval(buf, { s: 90000, e: 120000, path: P_FULL, names: N_FULL });
    assertEqual(buf.length, 3, 'over STUB_MS is real time at the app level');
});

test('pushInterval: stub between DIFFERENT paths is kept', () => {
    let buf = [];
    pushInterval(buf, { s: 0, e: 30000, path: P_FULL, names: N_FULL });
    pushInterval(buf, { s: 30000, e: 31000, path: P_APP, names: N_APP });
    pushInterval(buf, { s: 31000, e: 61000, path: ['kgx', 'pi'], names: ['Console', 'pi'] });
    assertEqual(buf.length, 3, 'neighbours differ, so the stub is a real transition');
});

test('pushInterval: non-prefix stub is kept', () => {
    let buf = [];
    pushInterval(buf, { s: 0, e: 30000, path: P_FULL, names: N_FULL });
    pushInterval(buf, { s: 30000, e: 31000, path: ['zen'], names: ['Zen'] });
    pushInterval(buf, { s: 31000, e: 61000, path: P_FULL, names: N_FULL });
    assertEqual(buf.length, 3, 'a real alt-tab away and back is not a resolve stub');
});

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { FakeSettings } from './fakeSettings.js';
import { IntervalLog, INTERVAL_DIR } from '../src/intervalLog.js';
import { sortedChildren } from '../src/usageStore.js';

// Epoch ms for a local wall-clock time, so day-boundary tests do not depend
// on the machine's timezone offset.
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

function dayFileLines(key) {
    let f = Gio.File.new_for_path(GLib.build_filenamev([INTERVAL_DIR, `${key}.ndjson`]));
    if (!f.query_exists(null))
        return [];
    let [, contents] = f.load_contents(null);
    return new TextDecoder().decode(contents).split('\n')
        .filter(l => l.length > 0).map(l => JSON.parse(l));
}

test('IntervalLog: flush writes all but the trailing two records', () => {
    let log = freshLog();
    let base = at(2026, 9, 11, 10);
    log.record(base, base + 30000, ['a'], ['A']);
    log.record(base + 40000, base + 70000, ['b'], ['B']);
    log.record(base + 80000, base + 110000, ['c'], ['C']);
    log.flush();
    assertEqual(dayFileLines('2026-09-11').length, 1, 'tail of two is held back to merge');
    log.flushAll();
    assertEqual(dayFileLines('2026-09-11').length, 3);
    log.destroy();
});

test('IntervalLog: trailing nulls are omitted from the line', () => {
    let log = freshLog();
    let base = at(2026, 9, 11, 10);
    log.record(base, base + 30000, ['kgx'], ['Console']);
    log.flushAll();
    assertEqual(dayFileLines('2026-09-11')[0],
        [base, base + 30000, 'kgx', 'Console']);
    log.destroy();
});

test('IntervalLog: a full path round-trips with names', () => {
    let log = freshLog();
    let base = at(2026, 9, 11, 10);
    log.record(base, base + 30000, ['kgx', 'claude', 'lab'], ['Console', 'claude', 'lab']);
    log.flushAll();
    assertEqual(dayFileLines('2026-09-11')[0],
        [base, base + 30000, 'kgx', 'Console', 'claude', 'claude', 'lab', 'lab']);
    log.destroy();
});

test('IntervalLog: query builds a tree crediting every ancestor', () => {
    let log = freshLog();
    let base = at(2026, 9, 11, 10);
    log.record(base, base + 30000, ['kgx', 'claude', 'lab'], ['Console', 'claude', 'lab']);
    log.record(base + 30000, base + 50000, ['kgx', 'claude', 'repo'], ['Console', 'claude', 'repo']);
    log.record(base + 50000, base + 60000, ['zen'], ['Zen']);
    log.flushAll();
    let { seconds, entries } = log.query(base, base + 60000);
    assertEqual(seconds, 60);
    assertEqual(entries.map(e => [e.appId, e.seconds]), [['kgx', 50], ['zen', 10]]);
    let level2 = sortedChildren(entries[0].children);
    assertEqual(level2.map(c => [c.id, c.seconds]), [['claude', 50]]);
    let level3 = sortedChildren(level2[0].children);
    assertEqual(level3.map(c => [c.id, c.seconds]), [['lab', 30], ['repo', 20]]);
    log.destroy();
});

test('IntervalLog: query clips intervals straddling the range edges', () => {
    let log = freshLog();
    let base = at(2026, 9, 11, 10);
    log.record(base, base + 30000, ['a'], ['A']);
    log.record(base + 30000, base + 60000, ['a'], ['A']);
    log.flushAll();
    let { seconds } = log.query(base + 20000, base + 45000);
    assertEqual(seconds, 25, 'only the overlapping 25s counts');
    log.destroy();
});

test('IntervalLog: query returns nothing for a range with no overlap', () => {
    let log = freshLog();
    let base = at(2026, 9, 11, 10);
    log.record(base, base + 30000, ['a'], ['A']);
    log.flushAll();
    assertEqual(log.query(base + 60000, base + 90000), { seconds: 0, entries: [] });
    log.destroy();
});

test('IntervalLog: records file under the logical day, honouring day-start-hour', () => {
    let log = freshLog(new FakeSettings({ 'day-start-hour': 4 }));
    let lateNight = at(2026, 9, 12, 1, 30);
    log.record(lateNight, lateNight + 30000, ['a'], ['A']);
    log.flushAll();
    assertEqual(dayFileLines('2026-09-11').length, 1, '01:30 belongs to the 11th when the day starts at 4');
    assertEqual(dayFileLines('2026-09-12').length, 0);
    log.destroy();
});

test('IntervalLog: query spans two day files', () => {
    let log = freshLog();
    let before = at(2026, 9, 11, 23, 50);
    let after = at(2026, 9, 12, 0, 10);
    log.record(before, before + 30000, ['a'], ['A']);
    log.record(after, after + 30000, ['b'], ['B']);
    log.flushAll();
    let { seconds, entries } = log.query(before, after + 30000);
    assertEqual(seconds, 60);
    assertEqual(entries.map(e => e.appId).sort(), ['a', 'b']);
    log.destroy();
});

test('IntervalLog: purge unlinks whole files older than retention', () => {
    let settings = new FakeSettings({ 'interval-retention-days': 30 });
    let log = freshLog(settings);
    let old = GLib.DateTime.new_now_local().add_days(-40).to_unix() * 1000;
    let recent = GLib.DateTime.new_now_local().add_days(-2).to_unix() * 1000;
    log.record(old, old + 30000, ['a'], ['A']);
    log.record(recent, recent + 30000, ['b'], ['B']);
    log.flushAll();
    log.purge();
    let names = [];
    let dir = Gio.File.new_for_path(INTERVAL_DIR);
    let e = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = e.next_file(null)) !== null)
        names.push(info.get_name());
    e.close(null);
    assertEqual(names.length, 1, 'the 40-day-old file is gone');
    log.destroy();
});

test('IntervalLog: retention 0 keeps everything', () => {
    let settings = new FakeSettings({ 'interval-retention-days': 0 });
    let log = freshLog(settings);
    let old = GLib.DateTime.new_now_local().add_days(-400).to_unix() * 1000;
    log.record(old, old + 30000, ['a'], ['A']);
    log.flushAll();
    log.purge();
    assertEqual(dayFileLines(GLib.DateTime.new_from_unix_local(old / 1000).format('%Y-%m-%d')).length, 1);
    log.destroy();
});
