import { test, assertEqual } from './harness.js';
import { dayArg, dayFromArgs } from '../src/timesheetArgs.js';

test('timesheetArgs: dayArg builds the --day argument', () => {
    assertEqual(dayArg('2026-09-12'), '--day=2026-09-12');
});

test('timesheetArgs: dayFromArgs reads a valid day back', () => {
    assertEqual(dayFromArgs(['timesheet.js', '--day=2026-09-12']), '2026-09-12');
});

test('timesheetArgs: dayFromArgs round-trips dayArg', () => {
    assertEqual(dayFromArgs([dayArg('2026-01-31')]), '2026-01-31');
});

test('timesheetArgs: no --day argument gives null', () => {
    assertEqual(dayFromArgs(['timesheet.js']), null);
    assertEqual(dayFromArgs([]), null);
});

test('timesheetArgs: a malformed or impossible day gives null', () => {
    for (let bad of ['--day=', '--day=yesterday', '--day=2026-9-12', '--day=2026-13-01',
        '--day=2026-02-30', '--day=2026-09-12x', '--day=../../etc'])
        assertEqual(dayFromArgs([bad]), null, bad);
});
