import { test, assertEqual } from './harness.js';
import { formatTime } from '../src/formatTime.js';

test('formatTime: minutes only below an hour', () => {
    assertEqual(formatTime(0), '0m');
    assertEqual(formatTime(60), '1m');
    assertEqual(formatTime(1800), '30m');
});

test('formatTime: seconds are dropped, never rounded up', () => {
    assertEqual(formatTime(59), '0m', 'under a minute reads as 0m, not 1m');
    assertEqual(formatTime(119), '1m');
    assertEqual(formatTime(3599), '59m');
});

test('formatTime: a whole hour drops the minutes part', () => {
    assertEqual(formatTime(3600), '1h');
    assertEqual(formatTime(7200), '2h');
    assertEqual(formatTime(3659), '1h', 'under a minute past the hour is still 1h');
});

test('formatTime: hours and minutes together', () => {
    assertEqual(formatTime(3660), '1h1m');
    assertEqual(formatTime(7325), '2h2m');
    assertEqual(formatTime(86399), '23h59m');
});
