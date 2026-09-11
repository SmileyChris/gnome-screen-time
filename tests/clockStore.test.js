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

test('ClockStore: billedSecondsByClient sums seconds per client across sessions', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.start('BETA', t + 3600000);      // closes ACME after 1h, opens BETA
    clock.start('ACME', t + 5400000);      // closes BETA after 30m, reopens ACME
    clock.stop(t + 9000000);               // closes ACME after another 1h
    let byClient = clock.billedSecondsByClient('2026-09-11', t + 9000000);
    assertEqual(Object.fromEntries(byClient), { ACME: 7200, BETA: 1800 },
        'ACME totals its two sessions; BETA its one');
    clock.destroy();
});

test('ClockStore: billedSecondsByClient honours a billedHours override per client, including zero', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let acme = clock.start('ACME', t);
    clock.stop(t + 3600000);               // 1h actual
    let beta = clock.start('BETA', t + 3600000);
    clock.stop(t + 7200000);               // 1h actual
    clock.update(acme.id, { billedHours: 2 });
    clock.update(beta.id, { billedHours: 0 });
    let byClient = clock.billedSecondsByClient('2026-09-11', t + 7200000);
    assertEqual(Object.fromEntries(byClient), { ACME: 7200, BETA: 0 },
        'the adjustment replaces actual time, and an explicit zero bills nothing');
    clock.destroy();
});

test('ClockStore: billedSecondsByClient accrues the running session live to nowMs', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.stop(t + 3600000);
    clock.start('BETA', t + 3600000);      // still running
    let byClient = clock.billedSecondsByClient('2026-09-11', t + 5400000);
    assertEqual(Object.fromEntries(byClient), { ACME: 3600, BETA: 1800 },
        'BETA is still open and accrues to the given nowMs');
    clock.destroy();
});

test('ClockStore: billedSecondsByClient sums to the same total as billedSecondsForDay', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.start('BETA', t + 3600000);
    clock.start('ACME', t + 5400000);      // left running
    let nowMs = t + 9000000;
    let byClient = clock.billedSecondsByClient('2026-09-11', nowMs);
    let sum = [...byClient.values()].reduce((s, v) => s + v, 0);
    assertEqual(sum, clock.billedSecondsForDay('2026-09-11', nowMs),
        'per-client rows and the day total must never disagree');
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

// The tie-break criterion under test is lastSeenMs, deliberately made to
// disagree with both array position and startMs: p starts latest but has
// the stalest heartbeat, q starts earliest but has the freshest heartbeat
// (and sits in the middle of the array, not last), r is in between on both.
// An implementation that used array position (`open[open.length - 1]`) or
// sorted by startMs instead of lastSeenMs would pick p, not q, and fail
// these tests.
test('ClockStore: recover keeps the freshest heartbeat running, not the latest start or last position', () => {
    GLib.unlink(CLOCK_FILE);
    let t = at(2026, 9, 11, 9, 0);
    let p = openSession('p', 'P', t + 20000, t + 1000);  // latest start, stalest heartbeat
    let q = openSession('q', 'Q', t, t + 9000);           // earliest start, freshest heartbeat
    let r = openSession('r', 'R', t + 10000, t + 5000);   // middle on both
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify({ sessions: [p, q, r] })),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let clock = new ClockStore(new FakeSettings());
    let interrupted = clock.recover(q.lastSeenMs + 60000); // under RESUME_GAP_MS for q
    assertEqual(interrupted.id, 'r', 'the most recently interrupted of the stale ones (p and r)');
    let day = clock.sessionsForDay('2026-09-11');
    let reloadedP = day.find(s => s.id === 'p');
    let reloadedR = day.find(s => s.id === 'r');
    assertEqual(reloadedP.endMs, p.lastSeenMs, 'closed at its own heartbeat');
    assertEqual(reloadedP.interrupted, true);
    assertEqual(reloadedR.endMs, r.lastSeenMs);
    assertEqual(reloadedR.interrupted, true);
    assertEqual(clock.running.id, 'q',
        'q has the freshest heartbeat even though it started first and sits mid-array');
    clock.destroy();
});

test('ClockStore: recover closes the freshest-heartbeat session too once its own gap is stale', () => {
    GLib.unlink(CLOCK_FILE);
    let t = at(2026, 9, 11, 9, 0);
    let p = openSession('p', 'P', t + 20000, t + 1000);
    let q = openSession('q', 'Q', t, t + 9000);
    let r = openSession('r', 'R', t + 10000, t + 5000);
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify({ sessions: [p, q, r] })),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let clock = new ClockStore(new FakeSettings());
    let interrupted = clock.recover(q.lastSeenMs + 7200000); // well past RESUME_GAP_MS for q too
    assertEqual(interrupted.id, 'q', 'the freshest-heartbeat session is also closed and reported');
    let day = clock.sessionsForDay('2026-09-11');
    assertEqual(day.every(s => s.interrupted), true, 'every session was interrupted');
    let reloadedQ = day.find(s => s.id === 'q');
    assertEqual(reloadedQ.endMs, q.lastSeenMs);
    assertEqual(clock.running, null);
    clock.destroy();
});

test('ClockStore: recover with nothing open returns null and touches nothing', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.stop(t + 3600000);
    let before = clock.sessionsForDay('2026-09-11');

    // _dirty alone doesn't discriminate here: _save() resets it to false on
    // any successful write, so a mutant recover() that spuriously called
    // _changed() would still leave _dirty === false. onChange firing is the
    // real tell.
    let fired = 0;
    clock.onChange = () => { fired++; };
    let result = clock.recover(t + 7200000);
    assertEqual(result, null);
    assertEqual(fired, 0, 'recover() with nothing open must not notify or save');
    assertEqual(clock.sessionsForDay('2026-09-11'), before, 'nothing changed');
    clock.destroy();
});

test('ClockStore: the stray-session anomaly log is throttled per session id', () => {
    GLib.unlink(CLOCK_FILE);
    let t = at(2026, 9, 11, 9, 0);
    let running = openSession('running-x', 'B', t + 3600000, t + 3600000);
    let strayOne = openSession('stray-x1', 'A', t, t + 1800000);
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify({ sessions: [running, strayOne] })),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let clock = new ClockStore(new FakeSettings());
    clock.billedSecondsForDay('2026-09-11', t + 5400000);
    clock.billedSecondsForDay('2026-09-11', t + 5500000);
    assertEqual(clock._reportedAnomalies.size, 1,
        'two calls against the same stray session log it only once');

    // A second, distinct stray session is still new to the throttle set.
    let strayTwo = openSession('stray-x2', 'C', t - 3600000, t - 1800000);
    clock._sessions.push(strayTwo);
    clock.billedSecondsForDay('2026-09-11', t + 5600000);
    assertEqual(clock._reportedAnomalies.size, 2, 'a distinct stray id is still reported');
    clock.destroy();
});

test('ClockStore: update on the running session checks overlap against the given nowMs, not the wall clock', () => {
    GLib.unlink(CLOCK_FILE);
    let t = at(2020, 1, 1, 9, 0);
    let beta = openSession('beta', 'BETA', t, t);
    let future = {
        id: 'future', client: 'OTHER', dayKey: '2020-01-01',
        startMs: t + 10800000, endMs: t + 14400000, lastSeenMs: t + 14400000,
        billedHours: null, description: '', interrupted: false,
        cleanStop: false, exportedAt: null,
    };
    beta.dayKey = '2020-01-01';
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify({ sessions: [beta, future] })),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let clock = new ClockStore(new FakeSettings());
    // Accepted: BETA is still running (endMs null), checked at a synthetic
    // "now" well before `future` starts. If update() fell back to the real
    // wall clock instead of the given nowMs, BETA's open-ended span would
    // run past `future`'s start and this would spuriously overlap.
    let updated = clock.update('beta', { startMs: t + 1800000 }, t + 3600000);
    assertEqual(updated.startMs, t + 1800000, 'no overlap: the synthetic now stays short of `future`');

    // Rejected: same edit, but checked at a synthetic now after `future`
    // has already started.
    let threw = null;
    try {
        clock.update('beta', { startMs: t + 1800000 }, t + 12000000);
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'overlap');
    clock.destroy();
});

test('ClockStore: update ignores fields outside the documented allowlist', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    let originalId = session.id;
    let updated = clock.update(session.id, {
        id: 'not-allowed',
        interrupted: true,
        billedHours: 0.5,
    });
    assertEqual(updated.id, originalId, 'id is not writable through update()');
    assertEqual(updated.interrupted, false, 'interrupted is not writable through update()');
    assertEqual(updated.billedHours, 0.5, 'the legitimate field in the same call still applies');
    clock.destroy();
});

test('ClockStore: update rejects reopening a closed session', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);

    let threw = null;
    try {
        clock.update(session.id, { endMs: null }, t + 7200000);
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'reopen');
    assertEqual(clock.sessionsForDay('2026-09-11')[0].endMs, t + 3600000, 'unchanged');
    assertEqual(clock.running, null, 'still nothing running; resuming is start()\'s job');
    clock.destroy();
});

test('ClockStore: update still accepts endMs: null for a session that is already running', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    // Still open; resending its own unchanged null endMs alongside a
    // legitimate edit is not a reopen and must not be rejected.
    let updated = clock.update(session.id, { startMs: t + 60000, endMs: null });
    assertEqual(updated.startMs, t + 60000);
    assertEqual(updated.endMs, null);
    assertEqual(clock.running.id, session.id, 'still the running session');
    clock.destroy();
});

// --- update() type validation ---
//
// update() is reached from D-Bus (UpdateSession(id, fieldsJson) ->
// JSON.parse() -> update()), so `fields` can carry any JSON-representable
// type at all. Each of these must throw 'invalid' before touching the
// session; the full record is compared before and after to prove nothing
// was mutated on the way to the throw.

function expectInvalid(clock, session, fields) {
    let before = JSON.parse(JSON.stringify(session));
    let threw = null;
    try {
        clock.update(session.id, fields);
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'invalid');
    assertEqual(session, before, 'the session is completely unchanged');
}

test('ClockStore: update rejects a non-numeric billedHours', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { billedHours: 'x' });
    clock.destroy();
});

test('ClockStore: update rejects a negative billedHours', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { billedHours: -1 });
    clock.destroy();
});

test('ClockStore: update rejects an infinite billedHours', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { billedHours: Infinity });
    clock.destroy();
});

test('ClockStore: update rejects a non-string description', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { description: 42 });
    clock.destroy();
});

test('ClockStore: update rejects a non-numeric startMs', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { startMs: 'abc' });
    clock.destroy();
});

test('ClockStore: update rejects a NaN startMs', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    // Every comparison against NaN is false, so the overlap/backwards checks
    // alone would let this straight through.
    expectInvalid(clock, session, { startMs: NaN });
    clock.destroy();
});

test('ClockStore: update rejects a non-integer startMs', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { startMs: t + 0.5 });
    clock.destroy();
});

test('ClockStore: update rejects a non-numeric endMs', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { endMs: 'abc' });
    clock.destroy();
});

test('ClockStore: update rejects a non-integer endMs', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { endMs: t + 3600000.5 });
    clock.destroy();
});

test('ClockStore: update rejects an empty client', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { client: '' });
    clock.destroy();
});

test('ClockStore: update rejects a whitespace-only client', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { client: '   ' });
    clock.destroy();
});

test('ClockStore: update ignores an explicit endMs: undefined on a closed session', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    let before = JSON.parse(JSON.stringify(session));
    let updated = clock.update(session.id, { endMs: undefined });
    assertEqual(updated, before, 'undefined is treated as absent, not as a reopen attempt');
    assertEqual(session, before, 'the session is unchanged');
    clock.destroy();
});

// --- _load() type validation ---
//
// clock.json can be hand-edited or partially corrupted between runs. A
// record failing these same per-field rules must be excluded from memory,
// never left to poison a billed total with NaN, and the original file must
// be preserved byte-for-byte before anything is dropped.

function listBackupFiles() {
    let dir = Gio.File.new_for_path(GLib.path_get_dirname(CLOCK_FILE));
    let names = [];
    let enumerator = dir.enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        if (info.get_name().startsWith('clock.json.invalid-'))
            names.push(info.get_name());
    }
    enumerator.close(null);
    return names;
}

function deleteBackupFiles() {
    let dir = GLib.path_get_dirname(CLOCK_FILE);
    for (let name of listBackupFiles())
        Gio.File.new_for_path(GLib.build_filenamev([dir, name])).delete(null);
}

test('ClockStore: load excludes an invalid record, keeps the valid one, and backs up the file once', () => {
    GLib.unlink(CLOCK_FILE);
    deleteBackupFiles();
    let t = at(2026, 9, 11, 9, 0);
    let valid = openSession('valid-1', 'ACME', t, t + 3600000);
    valid.endMs = t + 3600000;
    let invalid = openSession('invalid-1', 'BETA', t + 3600000, t + 7200000);
    invalid.endMs = t + 7200000;
    invalid.startMs = 'abc';   // the corruption
    let raw = JSON.stringify({ sessions: [valid, invalid] });
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(raw), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let clock = new ClockStore(new FakeSettings());
    let day = clock.sessionsForDay('2026-09-11');
    assertEqual(day.map(s => s.id), ['valid-1'], 'the invalid record is excluded, the valid one kept');
    assert(Number.isFinite(clock.billedSecondsForDay('2026-09-11', t + 7200000)),
        'the day total stays finite despite the excluded record');

    let backups = listBackupFiles();
    assertEqual(backups.length, 1, 'exactly one backup written for the whole load');
    let dir = GLib.path_get_dirname(CLOCK_FILE);
    let [, backupBytes] = Gio.File.new_for_path(
        GLib.build_filenamev([dir, backups[0]])).load_contents(null);
    assertEqual(new TextDecoder().decode(backupBytes), raw, 'the backup is byte-for-byte the original file');

    deleteBackupFiles();
    clock.destroy();
});

test('ClockStore: load excludes a record whose endMs precedes its own startMs, and backs up the file', () => {
    // Individually startMs and endMs are each a fine timestamp here - only
    // the pair is wrong. isValidField() checks one field at a time and
    // cannot catch this; it is isValidSessionRecord()'s cross-field check
    // that must.
    GLib.unlink(CLOCK_FILE);
    deleteBackupFiles();
    let t = at(2026, 9, 11, 9, 0);
    let valid = openSession('valid-2', 'ACME', t, t + 3600000);
    valid.endMs = t + 3600000;
    let backwards = openSession('backwards-1', 'BETA', t + 3600000, t + 3600000);
    backwards.endMs = t;   // before its own startMs
    let raw = JSON.stringify({ sessions: [valid, backwards] });
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(raw), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let clock = new ClockStore(new FakeSettings());
    let day = clock.sessionsForDay('2026-09-11');
    assertEqual(day.map(s => s.id), ['valid-2'], 'the backwards record is excluded, the valid one kept');

    let backups = listBackupFiles();
    assertEqual(backups.length, 1, 'the original file is backed up before the record is dropped');
    let dir = GLib.path_get_dirname(CLOCK_FILE);
    let [, backupBytes] = Gio.File.new_for_path(
        GLib.build_filenamev([dir, backups[0]])).load_contents(null);
    assertEqual(new TextDecoder().decode(backupBytes), raw, 'the backup is byte-for-byte the original file');

    deleteBackupFiles();
    clock.destroy();
});

test('ClockStore: load fills in defaults for a record missing interrupted/cleanStop/exportedAt, no backup', () => {
    GLib.unlink(CLOCK_FILE);
    deleteBackupFiles();
    let t = at(2026, 9, 11, 9, 0);
    let minimal = {
        id: 'minimal-1', client: 'ACME', dayKey: '2026-09-11',
        startMs: t, endMs: t + 3600000, lastSeenMs: t + 3600000,
        billedHours: null, description: '',
        // interrupted, cleanStop, exportedAt intentionally omitted
    };
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify({ sessions: [minimal] })),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let clock = new ClockStore(new FakeSettings());
    let [session] = clock.sessionsForDay('2026-09-11');
    assertEqual(session.interrupted, false);
    assertEqual(session.cleanStop, false);
    assertEqual(session.exportedAt, null);
    assertEqual(listBackupFiles().length, 0, 'missing optional fields are not corruption; no backup');
    clock.destroy();
});

// --- _load() must never silently empty a file it cannot parse ---
//
// A file that exists but cannot be turned into a sessions array at all
// (unparseable JSON, a non-object top level, or `sessions` not itself an
// array) is a different failure from "one bad record among good ones"
// above: there are no records to salvage, so the whole file must be backed
// up before _sessions is set to []. Without that, the very next save (any
// tap of the clock) overwrites the file with nothing and the user's whole
// billing history is gone with no trace. A genuinely missing file - the
// normal first run - must still produce no backup and no error.

function expectMalformedFileBackedUp(rawText) {
    GLib.unlink(CLOCK_FILE);
    deleteBackupFiles();
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(rawText), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let clock = new ClockStore(new FakeSettings());
    assertEqual(clock._sessions, [], 'nothing loads from a file that could not be read as a sessions array');

    let backups = listBackupFiles();
    assertEqual(backups.length, 1, 'exactly one backup written');
    let dir = GLib.path_get_dirname(CLOCK_FILE);
    let backupFile = Gio.File.new_for_path(GLib.build_filenamev([dir, backups[0]]));
    let [, backupBytes] = backupFile.load_contents(null);
    assertEqual(new TextDecoder().decode(backupBytes), rawText, 'the backup is byte-for-byte the original file');

    // A start() (and the immediate save it triggers) must not disturb the
    // backup: the corrupt original stays recoverable even once the clock is
    // used again.
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    assertEqual(listBackupFiles(), backups, 'the backup file is untouched by a later save');
    let [, sameBytes] = backupFile.load_contents(null);
    assertEqual(new TextDecoder().decode(sameBytes), rawText, 'and still byte-identical after that save');

    deleteBackupFiles();
    clock.destroy();
}

test('ClockStore: load backs up unparseable JSON instead of silently emptying it', () => {
    expectMalformedFileBackedUp('{ this is not json');
});

test('ClockStore: load backs up a top-level array instead of silently emptying it', () => {
    expectMalformedFileBackedUp('[1,2,3]');
});

test('ClockStore: load backs up a top-level string instead of silently emptying it', () => {
    expectMalformedFileBackedUp('"just a string"');
});

test('ClockStore: load backs up a top-level null instead of silently emptying it', () => {
    expectMalformedFileBackedUp('null');
});

test('ClockStore: load backs up a clock.json whose sessions field is not an array', () => {
    expectMalformedFileBackedUp(JSON.stringify({ sessions: 'oops' }));
});

test('ClockStore: load performs no backup when clock.json is simply missing', () => {
    GLib.unlink(CLOCK_FILE);
    deleteBackupFiles();
    let clock = new ClockStore(new FakeSettings());
    assertEqual(clock._sessions, [], 'nothing to load');
    assertEqual(listBackupFiles().length, 0, 'a missing file is the normal first run, not corruption');
    clock.destroy();
});

// --- timestamp magnitude bounds ---
//
// Number.isInteger(1e300) is true, so a bare finite-integer check lets a
// wildly out-of-range value through validation, into Object.assign, and
// only then does deriving a calendar day from it throw - after the session
// was already mutated. Every timestamp field must reject values outside a
// sane calendar window, not just non-integers and non-finite values.

test('ClockStore: update rejects an astronomically large startMs', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { startMs: 1e300 });
    clock.destroy();
});

test('ClockStore: update rejects a startMs just past Number.MAX_SAFE_INTEGER', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { startMs: Number.MAX_SAFE_INTEGER + 2 });
    clock.destroy();
});

test('ClockStore: update rejects an astronomically large endMs without corrupting the billed total', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    expectInvalid(clock, session, { endMs: 1e300 });
    // The bug this guards against: without a magnitude bound this would not
    // throw at all, and billedSecondsForDay would return something like
    // 1e297 instead of a sane number of seconds.
    assert(clock.running !== null, 'the session was never actually closed');
    clock.destroy();
});

test('ClockStore: update rejects an endMs just past Number.MAX_SAFE_INTEGER', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    expectInvalid(clock, session, { endMs: Number.MAX_SAFE_INTEGER + 2 });
    clock.destroy();
});

test('ClockStore: update rejects a startMs before the year 2000', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { startMs: 946684799999 });   // one ms before the window opens
    clock.destroy();
});

test('ClockStore: update rejects a startMs at or after the year 2100', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    expectInvalid(clock, session, { startMs: 4102444800000 });   // exactly the excluded upper bound
    clock.destroy();
});

test('ClockStore: update still accepts an ordinary 2026 startMs', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    let updated = clock.update(session.id, { startMs: t + 60000 });
    assertEqual(updated.startMs, t + 60000, 'a normal in-range value is unaffected by the new bound');
    clock.destroy();
});

// --- update() computes dayKey before mutating, not after ---

test('ClockStore: update moving startMs across a day boundary re-derives dayKey atomically', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 23, 30);
    let session = clock.start('ACME', t);
    clock.stop(t + 3600000);
    // Move the start to the next day: dayKey must be re-derived to match,
    // and it must land together with startMs in the same update - never one
    // without the other.
    let nextDay = at(2026, 9, 12, 0, 15);
    let updated = clock.update(session.id, { startMs: nextDay });
    assertEqual(updated.startMs, nextDay);
    assertEqual(updated.dayKey, '2026-09-12');
    clock.destroy();
});

// --- start() type validation ---

test('ClockStore: start rejects an empty client', () => {
    let clock = freshClock();
    let threw = null;
    try {
        clock.start('', at(2026, 9, 11, 9, 0));
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'invalid');
    assertEqual(clock.running, null, 'nothing was started');
    assertEqual(clock._sessions, [], 'the store is untouched');
    clock.destroy();
});

test('ClockStore: start rejects a whitespace-only client', () => {
    let clock = freshClock();
    let threw = null;
    try {
        clock.start('   ', at(2026, 9, 11, 9, 0));
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'invalid');
    assertEqual(clock.running, null);
    assertEqual(clock._sessions, []);
    clock.destroy();
});

// --- sessionById ---

test('ClockStore: sessionById finds a session by id regardless of its start time relative to now', () => {
    let clock = freshClock();
    // Deliberately "future" relative to any real wall-clock test run, unlike
    // sessionsInRange(0, Date.now()), which a future-dated session would
    // fall outside of.
    let future = at(2030, 1, 1, 9, 0);
    let session = clock.start('ACME', future);
    assertEqual(clock.sessionById(session.id), session);
    assertEqual(clock.sessionById('does-not-exist'), null);
    clock.destroy();
});

// --- read-only mode: never write a file whose original bytes weren't kept ---
//
// The invariant: if this store could not preserve a copy of what was
// already on disk - an unreadable file, or a corrupt one it failed to back
// up - it must never overwrite that file, no matter what happens in memory
// afterward, for the rest of its life.

test('ClockStore: an unreadable clock.json puts the store in read-only mode for its lifetime', () => {
    GLib.unlink(CLOCK_FILE);
    deleteBackupFiles();
    let t = at(2026, 9, 11, 9, 0);
    let record = openSession('real-1', 'ACME', t, t + 3600000);
    record.endMs = t + 3600000;
    let raw = JSON.stringify({ sessions: [record] });
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(raw), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    GLib.chmod(CLOCK_FILE, 0o000);
    let clock;
    try {
        clock = new ClockStore(new FakeSettings());
        assertEqual(clock._readOnly, true, 'a read failure puts the store into read-only mode');
        // The clock still works entirely in memory even though the file on
        // disk could never be read.
        let session = clock.start('BETA', t + 7200000);
        assert(session !== null && session.client === 'BETA', 'the store still works in memory');
    } finally {
        GLib.chmod(CLOCK_FILE, 0o644);
    }

    // Even now that the file is readable again, this store stays read-only
    // for the rest of its life: destroy()'s own save must not write over a
    // file whose original bytes it never actually held.
    clock.destroy();

    let [, bytesAfter] = Gio.File.new_for_path(CLOCK_FILE).load_contents(null);
    assertEqual(new TextDecoder().decode(bytesAfter), raw,
        'the original file is untouched, byte-for-byte, even after start() and destroy()');
    assertEqual(listBackupFiles().length, 0, 'a read failure has nothing in hand to back up');
});

test('ClockStore: read-only mode also engages when a corrupt file cannot be backed up', () => {
    GLib.unlink(CLOCK_FILE);
    deleteBackupFiles();
    let raw = '{ this is not json';
    Gio.File.new_for_path(CLOCK_FILE).replace_contents(
        new TextEncoder().encode(raw), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    // Read+execute only: the existing file is still readable, but nothing
    // new (the backup) can be created in the directory.
    let dir = GLib.path_get_dirname(CLOCK_FILE);
    GLib.chmod(dir, 0o555);
    let clock;
    try {
        clock = new ClockStore(new FakeSettings());
        assertEqual(clock._readOnly, true,
            'a failed backup is the same invariant as an unreadable file, just discovered later');
        assertEqual(clock._sessions, []);
    } finally {
        GLib.chmod(dir, 0o755);
    }

    clock.destroy();
    let [, bytesAfter] = Gio.File.new_for_path(CLOCK_FILE).load_contents(null);
    assertEqual(new TextDecoder().decode(bytesAfter), raw, 'the original is untouched');
    assertEqual(listBackupFiles().length, 0, 'the backup genuinely never got written');
});

// --- a 0-byte clock.json is empty, not corrupt ---

test('ClockStore: a 0-byte clock.json loads as empty, writes no backup, and later saves normally', () => {
    GLib.unlink(CLOCK_FILE);
    deleteBackupFiles();
    // NOT Gio.File.replace_contents(new Uint8Array(0), ...): in this GJS
    // that hits the same `contents != NULL` precondition failure the
    // source fix handles and never actually creates the file at all - a
    // fixture built that way would silently test the missing-file path
    // instead, which happens to assert the same outcomes for the wrong
    // reason. GLib.file_set_contents() genuinely writes a 0-byte file.
    GLib.file_set_contents(CLOCK_FILE, '');
    let fixture = Gio.File.new_for_path(CLOCK_FILE);
    assert(fixture.query_exists(null), 'the fixture file must actually exist');
    let info = fixture.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
    assertEqual(info.get_size(), 0, 'the fixture file must genuinely be 0 bytes');

    let clock = new ClockStore(new FakeSettings());
    assertEqual(clock._sessions, [], 'an empty file has no sessions to load');
    assertEqual(clock._readOnly, false,
        'an empty file is not corruption - false claims aside, the store must still be able to save');
    assertEqual(listBackupFiles().length, 0, 'nothing to back up for a file that never held anything');

    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    clock.destroySilently();

    let reopened = new ClockStore(new FakeSettings());
    assertEqual(reopened.running.id, session.id,
        'the save after loading an empty file actually reached disk - this store is not read-only');
    reopened.destroy();
});

// --- nowMs bounds on the methods that take it from a caller ---
//
// A machine whose clock is wrong (a dead CMOS battery booting into 1970, an
// NTP sync gone bad) can hand these methods' own default (Date.now()) a
// nonsensical value, not just a hostile caller. Each method is validated
// according to what it can tolerate: start()/stop() are user actions and
// must surface the failure; heartbeat() runs unattended and must never
// throw; closeForShutdown() runs from disable(), which must always finish.

test('ClockStore: start rejects an astronomically large nowMs, touching nothing', () => {
    let clock = freshClock();
    let threw = null;
    try {
        clock.start('ACME', 1e300);
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'invalid');
    assertEqual(clock.running, null);
    assertEqual(clock._sessions, []);
    clock.destroy();
});

test('ClockStore: start rejects a NaN nowMs, touching nothing', () => {
    let clock = freshClock();
    let threw = null;
    try {
        clock.start('ACME', NaN);
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'invalid');
    assertEqual(clock.running, null);
    assertEqual(clock._sessions, []);
    clock.destroy();
});

test('ClockStore: start with a bad nowMs while a session is running leaves it running, unchanged', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    let before = JSON.parse(JSON.stringify(session));
    let threw = null;
    try {
        clock.start('BETA', 1e300);
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'invalid');
    assertEqual(clock.running.id, session.id, 'still ACME, never switched');
    assertEqual(session, before, 'the running session is completely unchanged');
    clock.destroy();
});

test('ClockStore: stop rejects an astronomically large nowMs, leaving the session running', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    let before = JSON.parse(JSON.stringify(session));
    let threw = null;
    try {
        clock.stop(1e300);
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'invalid');
    assertEqual(clock.running.id, session.id, 'still running');
    assertEqual(session, before, 'unchanged');
    clock.destroy();
});

test('ClockStore: stop rejects a NaN nowMs, leaving the session running', () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    let session = clock.start('ACME', t);
    let before = JSON.parse(JSON.stringify(session));
    let threw = null;
    try {
        clock.stop(NaN);
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'invalid');
    assertEqual(clock.running.id, session.id);
    assertEqual(session, before);
    clock.destroy();
});

test('ClockStore: heartbeat silently skips an invalid nowMs, writing nothing', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.heartbeat(t + 30000);   // establish a known-good lastSeenMs first
    clock.heartbeat(1e300);
    assertEqual(clock.running.lastSeenMs, t + 30000, 'the bad heartbeat left lastSeenMs untouched');
    clock.heartbeat(NaN);
    assertEqual(clock.running.lastSeenMs, t + 30000, 'same for NaN');
    clock.destroySilently();

    let reopened = new ClockStore(settings);
    assertEqual(reopened.running.lastSeenMs, t + 30000, 'nothing bad ever reached disk either');
    reopened.destroy();
});

test("ClockStore: closeForShutdown falls back to the session's own lastSeenMs for an astronomical nowMs", () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.heartbeat(t + 30000);
    let closed = clock.closeForShutdown(1e300);
    assertEqual(closed.endMs, t + 30000, 'closed at its own last heartbeat, not the bad nowMs');
    assertEqual(closed.lastSeenMs, t + 30000);
    assertEqual(closed.cleanStop, true);
    clock.destroy();
});

test("ClockStore: closeForShutdown falls back to the session's own lastSeenMs for a NaN nowMs", () => {
    let clock = freshClock();
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    let closed = clock.closeForShutdown(NaN);
    assertEqual(closed.endMs, t, 'no heartbeat happened, so lastSeenMs is still the start time');
    clock.destroy();
});

// --- update()'s own nowMs must not be able to defeat the overlap check ---
//
// _overlaps() falls back to `nowMs` for any session still open (endMs ??
// nowMs). Every comparison against NaN is false, so a NaN or otherwise
// out-of-range nowMs made the overlap check never fire, letting update()
// persist two overlapping sessions to disk.

test('ClockStore: update rejects a NaN or astronomical nowMs before it can defeat the overlap check', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    let acme = clock.start('ACME', t);
    clock.stop(t + 3600000);                       // ACME: 9:00-10:00
    let beta = clock.start('BETA', t + 7200000);    // BETA: running from 11:00

    let acmeBefore = JSON.parse(JSON.stringify(acme));
    let betaBefore = JSON.parse(JSON.stringify(beta));

    // Sanity check: extending ACME's end to 11:30 overlaps BETA's
    // still-open span, and a real nowMs correctly catches it.
    let threw = null;
    try {
        clock.update(acme.id, { endMs: t + 9000000 }, t + 9000000);
    } catch (e) {
        threw = e.message;
    }
    assertEqual(threw, 'overlap', 'sanity check: a real nowMs still catches the overlap');

    for (let badNowMs of [NaN, 1e300]) {
        threw = null;
        try {
            clock.update(acme.id, { endMs: t + 9000000 }, badNowMs);
        } catch (e) {
            threw = e.message;
        }
        assertEqual(threw, 'invalid', `nowMs = ${badNowMs}`);
        assertEqual(acme, acmeBefore, `ACME unchanged in memory (nowMs = ${badNowMs})`);
        assertEqual(beta, betaBefore, `BETA unchanged in memory (nowMs = ${badNowMs})`);
    }

    clock.destroySilently();
    let reopened = new ClockStore(settings);
    assertEqual(reopened.sessionById(acme.id), acmeBefore, 'ACME on disk was never touched either');
    assertEqual(reopened.sessionById(beta.id), betaBefore, 'nor was BETA');
    reopened.destroy();
});

// --- recover() and a wrong clock ---
//
// recover() runs once, at enable(). On a machine whose clock is wrong it
// cannot distinguish a genuine `make reload` from a real outage, so an
// out-of-range nowMs must not let it guess either way by resuming or
// closing a session.

test('ClockStore: recover does nothing for an out-of-range nowMs, leaving a recently-heartbeated session running', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.heartbeat(t + 5000);   // heartbeated 5 seconds ago - well within RESUME_GAP_MS
    clock.destroySilently();     // simulates a crash: left open on disk, not cleanly closed

    let [, bytesBefore] = Gio.File.new_for_path(CLOCK_FILE).load_contents(null);

    let reopened = new ClockStore(settings);
    let before = JSON.parse(JSON.stringify(reopened.running));
    let fired = 0;
    reopened.onChange = () => { fired++; };

    assertEqual(reopened.recover(NaN), null, 'a wrong-clock nowMs cannot tell a reload from an outage');
    assertEqual(reopened.running, before, 'still open, completely unchanged');
    assertEqual(reopened.running.interrupted, false, 'not marked interrupted either');

    assertEqual(reopened.recover(1e300), null, 'same for an astronomically large nowMs');
    assertEqual(reopened.running, before, 'still unchanged');

    assertEqual(fired, 0, 'neither call triggered a save or a notification');
    reopened.destroySilently();

    let [, bytesAfter] = Gio.File.new_for_path(CLOCK_FILE).load_contents(null);
    assertEqual(new TextDecoder().decode(bytesAfter), new TextDecoder().decode(bytesBefore),
        'the file on disk is byte-identical to what it was before either recover() call');
});
