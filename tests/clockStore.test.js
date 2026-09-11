import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { test, assert, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import { ClockStore, CLOCK_FILE } from '../src/clockStore.js';

function at(y, mo, d, h, mi = 0) {
    return GLib.DateTime.new_local(y, mo, d, h, mi, 0).to_unix() * 1000;
}

function freshClock(settings = new FakeSettings()) {
    GLib.unlink(CLOCK_FILE);
    return new ClockStore(settings);
}

test('ClockStore: a new store has nothing running', () => {
    let clock = freshClock();
    assertEqual(clock.running, null);
    clock.destroy();
});

test('ClockStore: start opens a session with an end of null', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 15);
    let session = clock.start('ACME', t);
    assertEqual(session.client, 'ACME');
    assertEqual(session.startMs, t);
    assertEqual(session.endMs, null);
    assertEqual(session.billedHours, null);
    assertEqual(session.description, '');
    assertEqual(session.dayKey, '2026-09-11');
    assert(clock.running === session, 'the started session is the running one');
    clock.destroy();
});

test('ClockStore: stop closes it and clears running', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 15);
    clock.start('ACME', t);
    let stopped = clock.stop(t + 3600000);
    assertEqual(stopped.endMs, t + 3600000);
    assertEqual(clock.running, null);
    clock.destroy();
});

test('ClockStore: stop with nothing running returns null', () => {
    let clock = freshClock();
    assertEqual(clock.stop(at(2026, 9, 11, 10)), null);
    clock.destroy();
});

test('ClockStore: starting another client switches at the same instant', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 15);
    clock.start('ACME', t);
    clock.start('BETA', t + 3600000);
    let day = clock.sessionsForDay('2026-09-11');
    assertEqual(day.length, 2);
    assertEqual(day[0].client, 'ACME');
    assertEqual(day[0].endMs, t + 3600000, 'stopped exactly when the next started');
    assertEqual(day[1].client, 'BETA');
    assertEqual(day[1].startMs, t + 3600000, 'no gap between them');
    assertEqual(clock.running.client, 'BETA');
    clock.destroy();
});

test('ClockStore: starting the client already running is a no-op', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 15);
    let first = clock.start('ACME', t);
    let again = clock.start('ACME', t + 60000);
    assert(first === again, 'same session object');
    assertEqual(clock.sessionsForDay('2026-09-11').length, 1);
    clock.destroy();
});

test('ClockStore: toggle stops when running, starts when not', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 15);
    clock.toggle('ACME', t);
    assertEqual(clock.running.client, 'ACME');
    clock.toggle('ACME', t + 60000);
    assertEqual(clock.running, null);
    clock.destroy();
});

test('ClockStore: dayKey honours day-start-hour', () => {
    let clock = freshClock(new FakeSettings({ 'day-start-hour': 4 }));
    let session = clock.start('ACME', at(2026, 9, 12, 1, 30));
    assertEqual(session.dayKey, '2026-09-11', '01:30 belongs to the day that started at 04:00 on the 11th');
    clock.destroy();
});

test('ClockStore: a session crossing the day boundary is not split', () => {
    let clock = freshClock();
    clock.start('ACME', at(2026, 9, 11, 23, 0));
    clock.stop(at(2026, 9, 12, 2, 0));
    assertEqual(clock.sessionsForDay('2026-09-11').length, 1);
    assertEqual(clock.sessionsForDay('2026-09-12').length, 0, 'files under the start day only');
    clock.destroy();
});

test('ClockStore: dayKey is stamped at creation, not re-derived on read', () => {
    let settings = new FakeSettings({ 'day-start-hour': 0 });
    let clock = freshClock(settings);
    // 01:30 belongs to the 12th while the day starts at midnight.
    let session = clock.start('ACME', at(2026, 9, 12, 1, 30));
    clock.stop(at(2026, 9, 12, 2, 0));
    assertEqual(session.dayKey, '2026-09-12');

    // Moving the boundary afterwards must not re-file work already recorded.
    settings.set_int('day-start-hour', 4);
    assertEqual(clock.sessionsForDay('2026-09-12').length, 1,
        'an existing session keeps the key it was stamped with');
    assertEqual(clock.sessionsForDay('2026-09-11').length, 0,
        'changing the boundary is not retroactive');
    clock.destroy();
});

test('ClockStore: billedSecondsForDay uses actual until adjusted', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.stop(t + 3600000);           // 1h actual
    assertEqual(clock.billedSecondsForDay('2026-09-11', t + 3600000), 3600);
    clock.destroy();
});

test('ClockStore: billedSecondsForDay includes live elapsed for the running one', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.stop(t + 3600000);
    clock.start('BETA', t + 3600000);
    assertEqual(clock.billedSecondsForDay('2026-09-11', t + 5400000), 5400,
        '1h closed plus 30m still running');
    clock.destroy();
});

test('ClockStore: billedSecondsForDay clamps a stray open session to its lastSeenMs, not nowMs', () => {
    GLib.unlink(CLOCK_FILE);
    let t = at(2026, 9, 11, 9, 0);
    // Two open sessions should never happen through start/stop/toggle, but a
    // hand edit, an interrupted write, or a stale record can leave one on
    // disk. `running` only ever surfaces the first; the second must not be
    // able to accrue live seconds forever unnoticed.
    let running = {
        id: 'running-1', client: 'BETA', dayKey: '2026-09-11',
        startMs: t + 3600000, endMs: null, lastSeenMs: t + 3600000,
        billedHours: null, description: '', interrupted: false,
        cleanStop: false, exportedAt: null,
    };
    let stray = {
        id: 'stray-1', client: 'ACME', dayKey: '2026-09-11',
        startMs: t, endMs: null, lastSeenMs: t + 1800000,
        billedHours: null, description: '', interrupted: false,
        cleanStop: false, exportedAt: null,
    };
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify({ sessions: [running, stray] })),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let clock = new ClockStore(new FakeSettings());
    assertEqual(clock.running.id, 'running-1', 'the first open session is the one in play');
    assertEqual(clock.billedSecondsForDay('2026-09-11', t + 5400000), 1800 + 1800,
        'the running session accrues to now; the stray one stops at its own lastSeenMs');
    clock.destroy();
});

test('ClockStore: heartbeat advances lastSeenMs and persists it', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.heartbeat(t + 30000);
    // destroySilently(), not destroy(): destroy() now closes the running
    // session cleanly (Step 4), which would stamp endMs/lastSeenMs with the
    // real current time and defeat this test's purpose of checking that the
    // heartbeat's own write reached disk. See task-5-report.md for detail.
    clock.destroySilently();

    let reopened = new ClockStore(settings);
    assertEqual(reopened.running.lastSeenMs, t + 30000, 'the heartbeat reached disk');
    reopened.destroy();
});

test('ClockStore: recover resumes a session whose heartbeat is recent', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.heartbeat(t + 30000);
    clock.destroySilently();

    let reopened = new ClockStore(settings);
    let interrupted = reopened.recover(t + 60000);
    assertEqual(interrupted, null);
    assert(reopened.running !== null, 'a 30s gap is a Shell restart, not an ended session');
    reopened.destroy();
});

test('ClockStore: recover closes a stale session at its last heartbeat', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.heartbeat(t + 30000);
    clock.destroySilently();

    let reopened = new ClockStore(settings);
    let interrupted = reopened.recover(t + 7200000);
    assertEqual(reopened.running, null);
    assertEqual(interrupted.endMs, t + 30000, 'billed to the last heartbeat, not to now');
    assertEqual(interrupted.interrupted, true);
    reopened.destroy();
});

test('ClockStore: closeForShutdown marks a clean stop', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.closeForShutdown(t + 3600000);
    let [session] = clock.sessionsForDay('2026-09-11');
    assertEqual(session.endMs, t + 3600000);
    assertEqual(session.cleanStop, true);
    assertEqual(session.interrupted, false);
    clock.destroy();
});

test('ClockStore: update accepts a billed value of zero', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    clock.update(session.id, { billedHours: 0 });
    assertEqual(clock.billedSecondsForDay('2026-09-11', t + 3600000), 0,
        'a deliberately zeroed session bills nothing, not its actual hour');
    clock.destroy();
});

test('ClockStore: update sets billed hours and description', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 4680000);          // 1.30h actual
    let updated = clock.update(session.id, { billedHours: 1.25, description: 'invoicing setup' });
    assertEqual(updated.billedHours, 1.25);
    assertEqual(updated.description, 'invoicing setup');
    assertEqual(updated.endMs - updated.startMs, 4680000, 'actual is untouched by the adjustment');
    assertEqual(clock.billedSecondsForDay('2026-09-11', t + 4680000), 4500);
    clock.destroy();
});

test('ClockStore: update rejects a start time that overlaps a neighbour', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.stop(t + 3600000);
    let second = clock.start('BETA', t + 3600000);
    clock.stop(t + 7200000);

    let threw = null;
    try {
        clock.update(second.id, { startMs: t + 1800000 });
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'overlap');
    assertEqual(clock.sessionsForDay('2026-09-11')[1].startMs, t + 3600000, 'unchanged');
    clock.destroy();
});

test('ClockStore: update accepts a start time that just touches a neighbour', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.stop(t + 3600000);
    let second = clock.start('BETA', t + 5400000);
    clock.stop(t + 7200000);
    let updated = clock.update(second.id, { startMs: t + 3600000 });
    assertEqual(updated.startMs, t + 3600000, 'end-to-start contact is not an overlap');
    clock.destroy();
});

test('ClockStore: update rejects an end before the start', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    let threw = null;
    try {
        clock.update(session.id, { endMs: t - 1000 });
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'backwards');
    clock.destroy();
});

test('ClockStore: remove deletes a session', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    assertEqual(clock.remove(session.id), true);
    assertEqual(clock.sessionsForDay('2026-09-11').length, 0);
    assertEqual(clock.remove(session.id), false, 'removing twice is not an error');
    clock.destroy();
});

test('ClockStore: sessionsInRange returns anything intersecting the range', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.stop(t + 3600000);
    clock.start('BETA', t + 7200000);
    clock.stop(t + 10800000);
    let hit = clock.sessionsInRange(t + 1800000, t + 1900000);
    assertEqual(hit.map(s => s.client), ['ACME'], 'partial overlap counts');
    assertEqual(clock.sessionsInRange(t, t + 10800000).length, 2);
    assertEqual(clock.sessionsInRange(t + 4000000, t + 5000000).length, 0);
    clock.destroy();
});

// Not from the brief: covers the "every other open session is closed
// unconditionally" requirement for recover() (task instructions, not the
// brief's single-session sample code). Only one clock can run at a time, so
// more than one open session on disk is corruption a hand edit or a bad
// write could produce.
function openSession(id, client, startMs, lastSeenMs) {
    return {
        id, client, dayKey: '2026-09-11', startMs, endMs: null, lastSeenMs,
        billedHours: null, description: '', interrupted: false,
        cleanStop: false, exportedAt: null,
    };
}

test('ClockStore: recover closes every stale session, resuming only the freshest', () => {
    GLib.unlink(CLOCK_FILE);
    let t = at(2026, 9, 11, 9, 0);
    let a = openSession('a', 'A', t - 5000, t);
    let b = openSession('b', 'B', t, t + 1000);
    let c = openSession('c', 'C', t + 500, t + 2000);
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify({ sessions: [a, b, c] })),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let clock = new ClockStore(new FakeSettings());
    let interrupted = clock.recover(c.lastSeenMs + 60000); // under RESUME_GAP_MS for c
    assertEqual(interrupted.id, 'b', 'the most recently interrupted of the stale ones');
    let day = clock.sessionsForDay('2026-09-11');
    let reloadedA = day.find(s => s.id === 'a');
    let reloadedB = day.find(s => s.id === 'b');
    assertEqual(reloadedA.endMs, a.lastSeenMs, 'closed at its own heartbeat');
    assertEqual(reloadedA.interrupted, true);
    assertEqual(reloadedB.endMs, b.lastSeenMs);
    assertEqual(reloadedB.interrupted, true);
    assertEqual(clock.running.id, 'c', 'the freshest session resumes');
    clock.destroy();
});

test('ClockStore: recover closes the freshest session too once its own gap is stale', () => {
    GLib.unlink(CLOCK_FILE);
    let t = at(2026, 9, 11, 9, 0);
    let a = openSession('a', 'A', t - 5000, t);
    let b = openSession('b', 'B', t, t + 1000);
    let c = openSession('c', 'C', t + 500, t + 2000);
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify({ sessions: [a, b, c] })),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let clock = new ClockStore(new FakeSettings());
    let interrupted = clock.recover(c.lastSeenMs + 7200000); // well past RESUME_GAP_MS
    assertEqual(interrupted.id, 'c', 'the freshest session is also closed and reported');
    let day = clock.sessionsForDay('2026-09-11');
    assertEqual(day.every(s => s.interrupted), true, 'every session was interrupted');
    let reloadedC = day.find(s => s.id === 'c');
    assertEqual(reloadedC.endMs, c.lastSeenMs);
    assertEqual(clock.running, null);
    clock.destroy();
});
