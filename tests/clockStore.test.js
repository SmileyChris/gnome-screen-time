import GLib from 'gi://GLib';
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

test('ClockStore: dayKey is stable across a timezone change', () => {
    let clock = freshClock();
    // NZ springs forward on 27 September 2026. A session stamped before the
    // change keeps its key regardless of how the offset later moves.
    let session = clock.start('ACME', at(2026, 9, 26, 22, 0));
    let stamped = session.dayKey;
    clock.stop(at(2026, 9, 26, 23, 0));
    assertEqual(clock.sessionsForDay(stamped).length, 1);
    assertEqual(stamped, '2026-09-26');
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
