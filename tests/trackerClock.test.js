import { test, assertEqual } from './harness.js';
import { advanceClock } from '../src/trackerClock.js';

const MAX = 60;

// Flushes at each of the given times, starting the clock at 0, and returns
// the total credited plus where the clock ended up.
function run(times, maxSecs = MAX) {
    let lastTime = 0, total = 0;
    for (let now of times) {
        let r = advanceClock(lastTime, now, maxSecs);
        total += r.credited;
        lastTime = r.lastTime;
    }
    return { total, lastTime };
}

test('advanceClock: whole seconds credit exactly and leave no residual', () => {
    let r = advanceClock(0, 5000, MAX);
    assertEqual(r.credited, 5);
    assertEqual(r.lastTime, 5000);
});

test('advanceClock: a fraction rounded down stays on the clock', () => {
    let r = advanceClock(0, 1400, MAX);
    assertEqual(r.credited, 1);
    assertEqual(r.lastTime, 1000, 'the 0.4s is carried to the next flush');
});

test('advanceClock: a round-up is repaid by the next flush', () => {
    let r = advanceClock(0, 1600, MAX);
    assertEqual(r.credited, 2);
    assertEqual(r.lastTime, 2000, 'the clock runs 0.4s ahead');
    r = advanceClock(r.lastTime, 1900, MAX);
    assertEqual(r.credited, 0, 'still in debt, nothing credited');
    assertEqual(r.lastTime, 2000, 'and the clock is left where it was');
});

test('advanceClock: many short flushes add up to the real total', () => {
    // Ten 0.4s stretches: rounding each alone would credit nothing.
    let times = Array.from({ length: 10 }, (_, i) => (i + 1) * 400);
    assertEqual(run(times).total, 4);
    // Ten 0.6s stretches: rounding each alone would credit 10.
    times = Array.from({ length: 10 }, (_, i) => (i + 1) * 600);
    assertEqual(run(times).total, 6);
});

test('advanceClock: a capped stretch drops the excess and carries nothing', () => {
    let r = advanceClock(0, 90500, MAX);
    assertEqual(r.credited, MAX);
    assertEqual(r.lastTime, 90500, 'the clock restarts at now');
});

test('advanceClock: a clock jumping back resynchronises', () => {
    let r = advanceClock(10000, 5000, MAX);
    assertEqual(r.credited, 0);
    assertEqual(r.lastTime, 5000);
});
