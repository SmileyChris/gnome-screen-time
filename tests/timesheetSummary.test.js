import { test, assertEqual } from './harness.js';
import { dayHeading } from '../src/timesheetSummary.js';

const H = 3600000;

function session(client, startH, endH, over = {}) {
    return {
        client,
        startMs: startH * H,
        endMs: endH === null ? null : endH * H,
        billedHours: null,
        ...over,
    };
}

test('dayHeading: one client\'s hours go inline, nothing below', () => {
    assertEqual(dayHeading([session('ACME', 9, 11.5)]), { inline: 'ACME 2.50 h', below: '' });
});

test('dayHeading: several clients put the total inline, each client below', () => {
    let heading = dayHeading([
        session('ACME', 10, 12.5),
        session('BETA', 9, 10),
        session('BETA', 13, 13.5),
    ]);
    assertEqual(heading, { inline: 'Total 4.00 h', below: 'BETA 1.50 h · ACME 2.50 h' });
});

test('dayHeading: an hours override replaces the actual time', () => {
    assertEqual(dayHeading([session('ACME', 9, 11, { billedHours: 1.25 })]), { inline: 'ACME 1.25 h', below: '' });
});

test('dayHeading: an override of 0 counts as 0, not as unset', () => {
    assertEqual(dayHeading([session('ACME', 9, 11, { billedHours: 0 })]), { inline: 'ACME 0.00 h', below: '' });
});

test('dayHeading: a running session counts up to now', () => {
    assertEqual(dayHeading([session('ACME', 9, null)], 10.75 * H), { inline: 'ACME 1.75 h', below: '' });
});

// Each client rounds once, like its export row. The total adds the rounded
// figures, so it matches what the invoicing side sums from the rows. Here
// that is 1.01 + 0.34 = 1.35, where rounding the raw day sum (1.34 h) would
// not match. Times are whole milliseconds (0.335 h is 1206000 ms), so no
// floating-point input muddies the rounding under test.
test('dayHeading: each client rounds once and the total adds the rounded figures', () => {
    let third = 1206000;
    let at = (client, i) => ({ client, startMs: i * H, endMs: i * H + third, billedHours: null });
    let heading = dayHeading([at('ACME', 0), at('ACME', 1), at('ACME', 2), at('BETA', 3)]);
    assertEqual(heading, { inline: 'Total 1.35 h', below: 'ACME 1.01 h · BETA 0.34 h' });
});

test('dayHeading: no sessions gives an empty heading', () => {
    assertEqual(dayHeading([]), { inline: '', below: '' });
});
