import { test, assertEqual } from './harness.js';
import { nudgeDue } from '../src/nudge.js';

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
