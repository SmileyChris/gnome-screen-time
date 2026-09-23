import { test, assertEqual } from './harness.js';
import { dayArg, dayFromArgs, CLIENTS_ARG, pageFromArgs, timesheetArgv } from '../src/timesheetArgs.js';

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

test('timesheetArgs: pageFromArgs defaults to sessions', () => {
    assertEqual(pageFromArgs(['timesheet.js']), 'sessions');
    assertEqual(pageFromArgs([]), 'sessions');
});

test('timesheetArgs: --clients selects the clients page, with or without --day', () => {
    assertEqual(pageFromArgs([CLIENTS_ARG]), 'clients');
    assertEqual(pageFromArgs(['--day=2026-09-12', CLIENTS_ARG]), 'clients');
    assertEqual(dayFromArgs(['--day=2026-09-12', CLIENTS_ARG]), '2026-09-12');
});

test('timesheetArgs: timesheetArgv with no options is just the gjs command', () => {
    assertEqual(timesheetArgv('/ext/dir').join(' '),
        '/usr/bin/gjs -m /ext/dir/timesheet.js');
});

test('timesheetArgs: timesheetArgv appends --day when given a day', () => {
    assertEqual(timesheetArgv('/ext/dir', { day: '2026-09-12' }).join(' '),
        '/usr/bin/gjs -m /ext/dir/timesheet.js --day=2026-09-12');
});

test('timesheetArgs: timesheetArgv appends --clients when asked', () => {
    assertEqual(timesheetArgv('/ext/dir', { clients: true }).join(' '),
        '/usr/bin/gjs -m /ext/dir/timesheet.js --clients');
});

test('timesheetArgs: timesheetArgv can combine day and clients', () => {
    assertEqual(timesheetArgv('/ext/dir', { day: '2026-09-12', clients: true }).join(' '),
        '/usr/bin/gjs -m /ext/dir/timesheet.js --day=2026-09-12 --clients');
});
