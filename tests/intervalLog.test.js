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
    assertEqual(log.query(base + 60000, base + 90000), { seconds: 0, entries: [], firstMs: null });
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

// Writes raw content to a day file, bypassing IntervalLog entirely, so a
// crash mid-write or on-disk corruption can be simulated exactly.
function writeDayFile(key, content) {
    Gio.File.new_for_path(GLib.build_filenamev([INTERVAL_DIR, `${key}.ndjson`]))
        .replace_contents(new TextEncoder().encode(content), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

test('IntervalLog: a truncated final line does not lose the earlier records', () => {
    let log = freshLog();
    let base = at(2026, 9, 11, 10);
    // Mimics a crash mid-write_all: two complete lines, then a partial third.
    let content = `${JSON.stringify([base, base + 30000, 'a', 'A'])}\n` +
        `${JSON.stringify([base + 40000, base + 70000, 'b', 'B'])}\n` +
        `[${base + 80000},9000`;
    writeDayFile('2026-09-11', content);
    let { seconds, entries } = log.query(base, base + 70000);
    assertEqual(seconds, 60, 'both earlier records recovered despite the truncated tail');
    assertEqual(entries.map(e => e.appId).sort(), ['a', 'b']);
    log.destroy();
});

test('IntervalLog: a malformed line in the middle does not affect its neighbours', () => {
    let log = freshLog();
    let base = at(2026, 9, 11, 10);
    let content = `${JSON.stringify([base, base + 30000, 'a', 'A'])}\n` +
        `not json\n` +
        `${JSON.stringify([base + 40000, base + 70000, 'b', 'B'])}\n`;
    writeDayFile('2026-09-11', content);
    let { seconds, entries } = log.query(base, base + 70000);
    assertEqual(seconds, 60, 'the malformed middle line is skipped, not fatal to its neighbours');
    assertEqual(entries.map(e => e.appId).sort(), ['a', 'b']);
    log.destroy();
});

test('IntervalLog: rounding keeps a parent equal to the sum of its children on fractional windows', () => {
    let log = freshLog();
    let base = at(2026, 9, 11, 10);
    log.record(base, base + 1000, ['kgx', 'a1'], ['Console', 'A1']);
    log.record(base + 1000, base + 2000, ['kgx', 'a2'], ['Console', 'A2']);
    log.flushAll();
    // A window not aligned to whole seconds clips each record to 0.5s.
    let { seconds, entries } = log.query(base + 500, base + 1500);
    let kgx = entries.find(e => e.appId === 'kgx');
    let children = sortedChildren(kgx.children);
    let childSum = children.reduce((sum, c) => sum + c.seconds, 0);
    assertEqual(kgx.seconds, childSum, 'parent equals the sum of its rounded children');
    assertEqual(seconds, entries.reduce((sum, e) => sum + e.seconds, 0),
        'the reported total equals the sum of the top-level entries');
    log.destroy();
});

test('IntervalLog: rounding combines a parent\'s own time with its rounded children correctly', () => {
    let log = freshLog();
    let base = at(2026, 9, 11, 10);
    // Own (app-level) time plus two child records, back to back.
    log.record(base, base + 1000, ['kgx'], ['Console']);
    log.record(base + 1000, base + 2000, ['kgx', 'a1'], ['Console', 'A1']);
    log.record(base + 2000, base + 3000, ['kgx', 'a2'], ['Console', 'A2']);
    log.flushAll();
    // A window not aligned to whole seconds: own clips to 0.5s, a1 stays a
    // full 1s, a2 clips to 0.5s.
    let { seconds, entries } = log.query(base + 500, base + 2500);
    let kgx = entries.find(e => e.appId === 'kgx');
    let children = sortedChildren(kgx.children);
    let childSum = children.reduce((sum, c) => sum + c.seconds, 0);
    // Correct (bottom-up, raw child sum taken before recursing): own's raw
    // 0.5s rounds to 1 and adds to the rounded children (1 + 1 = 2), giving
    // 3. A reorder that recurses first and then sums the CHILDREN'S ALREADY
    // ROUNDED values to subtract from the parent's raw total would compute
    // own = max(0, 2.0 - 2) = 0, giving 2 instead — own's rounded time
    // would be silently swallowed by its children's rounding.
    assertEqual(kgx.seconds, 3, "own's rounded 0.5s is not swallowed by its children's rounding");
    assertEqual(kgx.seconds, childSum + Math.round(0.5),
        'parent equals its rounded children plus its own rounded remainder');
    assertEqual(seconds, entries.reduce((sum, e) => sum + e.seconds, 0),
        'the reported total equals the sum of the top-level entries');
    log.destroy();
});

test('IntervalLog: a same-batch failure on one day does not duplicate a day that already wrote', () => {
    let log = freshLog();
    let before = at(2026, 9, 11, 23, 50);
    let after = at(2026, 9, 12, 0, 10);
    let blockedPath = GLib.build_filenamev([INTERVAL_DIR, '2026-09-12.ndjson']);
    // Block only the second day's file, so day 1's append can succeed while
    // day 2's throws in the same _writeOut() call.
    Gio.File.new_for_path(blockedPath).make_directory_with_parents(null);
    log.record(before, before + 30000, ['a'], ['A']);
    log.record(after, after + 30000, ['b'], ['B']);
    log.flushAll();
    assertEqual(dayFileLines('2026-09-11').length, 1, 'day 1 landed on the first flush');
    Gio.File.new_for_path(blockedPath).delete(null);
    log.flushAll();
    assertEqual(dayFileLines('2026-09-11').length, 1,
        'day 1 is not re-appended just because day 2 failed alongside it');
    assertEqual(dayFileLines('2026-09-12').length, 1);
    log.destroy();
});

test('IntervalLog: a failed append keeps the batch buffered for retry', () => {
    let log = freshLog();
    let base = at(2026, 9, 11, 10);
    let blockedPath = GLib.build_filenamev([INTERVAL_DIR, '2026-09-11.ndjson']);
    // A directory at the day file's path makes append_to() throw, standing
    // in for a disk error (full, permission, quota) without needing one.
    Gio.File.new_for_path(blockedPath).make_directory_with_parents(null);
    log.record(base, base + 30000, ['a'], ['A']);
    log.record(base + 40000, base + 70000, ['b'], ['B']);
    log.record(base + 80000, base + 110000, ['c'], ['C']);
    log.flushAll();
    Gio.File.new_for_path(blockedPath).delete(null);
    log.flushAll();
    assertEqual(dayFileLines('2026-09-11').length, 3, 'the failed write did not lose the batch');
    log.destroy();
});
