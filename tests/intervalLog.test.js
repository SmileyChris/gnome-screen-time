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
