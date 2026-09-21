import { test, assertEqual } from './harness.js';
import { nudgeDue, awayMomentMs, awayNudgeDue } from '../src/nudge.js';

const MIN = 60 * 1000;
const HOUR = 3600 * 1000;
const T0 = 1_700_000_000_000;   // an arbitrary but fixed "now"

test('nudge: not due before the threshold', () => {
    assertEqual(nudgeDue(T0, 0, T0 + 29 * MIN, 30), false);
});

test('nudge: due exactly at the threshold', () => {
    assertEqual(nudgeDue(T0, 0, T0 + 30 * MIN, 30), true);
});

test('nudge: due well past the threshold with no prior nudge', () => {
    assertEqual(nudgeDue(T0, 0, T0 + 45 * MIN, 30), true);
});

test('nudge: not due again within the hour after a nudge', () => {
    let nudgedAt = T0 + 30 * MIN;
    assertEqual(nudgeDue(T0, nudgedAt, nudgedAt + 59 * MIN, 30), false);
});

test('nudge: due again exactly an hour after the last nudge', () => {
    let nudgedAt = T0 + 30 * MIN;
    assertEqual(nudgeDue(T0, nudgedAt, nudgedAt + HOUR, 30), true);
});

test('nudge: due again well past an hour after the last nudge', () => {
    let nudgedAt = T0 + 30 * MIN;
    assertEqual(nudgeDue(T0, nudgedAt, nudgedAt + 2 * HOUR, 30), true);
});

test('nudge: never due when the threshold is 0, however long away', () => {
    assertEqual(nudgeDue(T0, 0, T0 + 10 * HOUR, 0), false);
});

test('nudge: never due when nothing is away', () => {
    assertEqual(nudgeDue(0, 0, T0 + 10 * HOUR, 30), false);
});

test('nudge: a zero threshold overrides even a very old away instant and no prior nudge', () => {
    assertEqual(nudgeDue(T0 - 10 * HOUR, 0, T0, 0), false);
});

// --- awayMomentMs: the away-on-unlock moment ---

test('awayMomentMs: the tracker\'s own away-since wins when it is earlier than the heartbeat', () => {
    let heldAwaySince = T0;
    let lastSeenMs = T0 + 20 * MIN;
    assertEqual(awayMomentMs(heldAwaySince, lastSeenMs), T0);
});

test('awayMomentMs: falls back to lastSeenMs when the tracker never noticed (0)', () => {
    let lastSeenMs = T0 + 20 * MIN;
    assertEqual(awayMomentMs(0, lastSeenMs), lastSeenMs);
});

test('awayMomentMs: lastSeenMs wins when it is earlier than the tracker\'s own instant', () => {
    let heldAwaySince = T0 + 20 * MIN;
    let lastSeenMs = T0;
    assertEqual(awayMomentMs(heldAwaySince, lastSeenMs), T0);
});

// --- awayNudgeDue ---

test('awayNudgeDue: not due before the threshold', () => {
    assertEqual(awayNudgeDue(T0, T0 + 29 * MIN, 30), false);
});

test('awayNudgeDue: due exactly at the threshold', () => {
    assertEqual(awayNudgeDue(T0, T0 + 30 * MIN, 30), true);
});

test('awayNudgeDue: due well past the threshold', () => {
    assertEqual(awayNudgeDue(T0, T0 + 10 * HOUR, 30), true);
});

test('awayNudgeDue: a zero threshold disables it however long the gap', () => {
    assertEqual(awayNudgeDue(T0 - 10 * HOUR, T0, 0), false);
});
