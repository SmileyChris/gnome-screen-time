import GLib from 'gi://GLib';
import { test, assertEqual } from './harness.js';
import { parseClock } from '../src/clockTime.js';

function at(y, mo, d, h, mi = 0) {
    return GLib.DateTime.new_local(y, mo, d, h, mi, 0).to_unix() * 1000;
}

function fmt(ms) {
    return GLib.DateTime.new_from_unix_local(ms / 1000).format('%Y-%m-%d %H:%M');
}

test('parseClock: a start shown just after midnight snaps to the day before when nearer', () => {
    // Started reads 00:10 on the 11th; the session actually began at 23:50
    // on the 10th. Resolving onto the display's own day (the 11th) would
    // land nearly a full day later - this is the owner's everyday
    // late-night correction.
    let ref = at(2026, 9, 11, 0, 10);
    assertEqual(fmt(parseClock('23:50', ref)), '2026-09-10 23:50');
});

test('parseClock: an end typed past midnight snaps to the day after when nearer', () => {
    let ref = at(2026, 9, 10, 23, 0);
    assertEqual(fmt(parseClock('01:30', ref)), '2026-09-11 01:30');
});

test('parseClock: a same-day correction stays on the reference day', () => {
    let ref = at(2026, 9, 11, 9, 15);
    assertEqual(fmt(parseClock('09:05', ref)), '2026-09-11 09:05');
});

test('parseClock: on an exact tie, the earlier candidate wins', () => {
    // "00:00" is exactly 12h before referenceMs on the reference's own day
    // and exactly 12h after it on the following day - a genuine tie.
    let ref = at(2026, 9, 11, 12, 0);
    assertEqual(fmt(parseClock('00:00', ref)), '2026-09-11 00:00');
});

test('parseClock: rejects an out-of-range hour', () => {
    assertEqual(parseClock('24:00', at(2026, 9, 11, 9, 0)), null);
});

test('parseClock: rejects an out-of-range minute', () => {
    assertEqual(parseClock('9:60', at(2026, 9, 11, 9, 0)), null);
});

test('parseClock: rejects a bare hour with no minutes', () => {
    assertEqual(parseClock('9', at(2026, 9, 11, 9, 0)), null);
});

test('parseClock: rejects a one-digit minute', () => {
    assertEqual(parseClock('9:5', at(2026, 9, 11, 9, 0)), null);
});

test('parseClock: rejects non-numeric text', () => {
    assertEqual(parseClock('abc', at(2026, 9, 11, 9, 0)), null);
});

test('parseClock: rejects an empty string', () => {
    assertEqual(parseClock('', at(2026, 9, 11, 9, 0)), null);
});

test('parseClock: rejects whitespace-only text', () => {
    assertEqual(parseClock('   ', at(2026, 9, 11, 9, 0)), null);
});

// parseClock builds candidates with GLib.DateTime.new_local, which resolves
// in the machine's own zone - not something a test can point at a fixed
// zone without changing parseClock's signature. These two tests instead pin
// GLib.DateTime's own DST handling directly, via an explicit
// Pacific/Auckland GLib.TimeZone (independent of whatever zone the test
// machine happens to run in), to document and lock in the exact behaviour
// parseClock's own DST comment relies on.
test('GLib.DateTime DST semantics: a spring-forward gap time clamps forward (NZ, 2026-09-27)', () => {
    let tz = GLib.TimeZone.new_identifier('Pacific/Auckland');
    // 02:00-02:59 does not exist on this day: NZ jumps from 02:00 NZST
    // straight to 03:00 NZDT. 02:30 is silently clamped to 03:00, not
    // rejected and not shifted by the size of the gap (30 minutes in).
    let gap = GLib.DateTime.new(tz, 2026, 9, 27, 2, 30, 0);
    assertEqual([gap.get_hour(), gap.get_minute()], [3, 0]);
});

test('GLib.DateTime DST semantics: a fall-back ambiguous time resolves to the later occurrence (NZ, 2026-04-05)', () => {
    let tz = GLib.TimeZone.new_identifier('Pacific/Auckland');
    // 02:00-02:59 happens twice on this day: once as NZDT (UTC+13, the
    // earlier of the two real instants) and again an hour later as NZST
    // (UTC+12, the later instant), once daylight time has ended. GLib
    // resolves the ambiguous local time to the later of the two - NZST.
    let amb = GLib.DateTime.new(tz, 2026, 4, 5, 2, 30, 0);
    assertEqual(amb.get_utc_offset() / 1000000, 12 * 3600, 'NZST (+12:00), not NZDT (+13:00)');
});
