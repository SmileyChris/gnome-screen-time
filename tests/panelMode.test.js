import GLib from 'gi://GLib';
import { test, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import { ClockStore, CLOCK_FILE } from '../src/clockStore.js';
import { migratePanelSetting, panelLabelText, panelLabelDimmed, panelClockState } from '../src/panelMode.js';

function at(y, mo, d, h, mi = 0) {
    return GLib.DateTime.new_local(y, mo, d, h, mi, 0).to_unix() * 1000;
}

function freshClock(settings = new FakeSettings()) {
    GLib.unlink(CLOCK_FILE);
    return new ClockStore(settings);
}

// --- migratePanelSetting ---

test('panelMode: migratePanelSetting turns an old `true` into "screen"', () => {
    let settings = new FakeSettings();
    settings.set_boolean('show-total-in-panel', true);
    migratePanelSetting(settings);
    assertEqual(settings.get_string('panel-time'), 'screen');
});

test('panelMode: migratePanelSetting turns an old `false` into "none"', () => {
    let settings = new FakeSettings();
    settings.set_boolean('show-total-in-panel', false);
    migratePanelSetting(settings);
    assertEqual(settings.get_string('panel-time'), 'none');
});

test('panelMode: migratePanelSetting sets the migration marker', () => {
    let settings = new FakeSettings();
    assertEqual(settings.get_boolean('panel-time-migrated'), false);
    migratePanelSetting(settings);
    assertEqual(settings.get_boolean('panel-time-migrated'), true);
});

test('panelMode: a second call after the user has since changed panel-time does not overwrite it', () => {
    let settings = new FakeSettings();
    settings.set_boolean('show-total-in-panel', true);
    migratePanelSetting(settings);
    assertEqual(settings.get_string('panel-time'), 'screen');

    settings.set_string('panel-time', 'none');   // the user's own later choice
    migratePanelSetting(settings);
    assertEqual(settings.get_string('panel-time'), 'none',
        'a re-run after the marker is set must leave the user\'s choice alone');
});

test('panelMode: already-migrated is a no-op, even if show-total-in-panel would map elsewhere', () => {
    let settings = new FakeSettings();
    settings.set_boolean('panel-time-migrated', true);
    settings.set_string('panel-time', 'client');
    settings.set_boolean('show-total-in-panel', false); // would produce "none" if consulted

    migratePanelSetting(settings);
    assertEqual(settings.get_string('panel-time'), 'client',
        'already migrated: show-total-in-panel must not be read at all');
    assertEqual(settings.get_boolean('panel-time-migrated'), true);
});

// --- panelLabelText ---

const stopped = (seconds = 0) => ({ running: false, away: false, paused: false, client: '', seconds });
const paused = (seconds = 0, client = 'ACME') => ({ running: false, away: false, paused: true, client, seconds });
const running = (client, seconds) => ({ running: true, away: false, paused: false, client, seconds });

test('panelLabelText: "screen" mode shows the formatted total when there is time today', () => {
    assertEqual(panelLabelText('screen', 720, stopped()), '12m');
});

test('panelLabelText: "screen" mode hides at zero', () => {
    assertEqual(panelLabelText('screen', 0, stopped()), '');
});

test('panelLabelText: "client" mode running shows the client and elapsed time', () => {
    assertEqual(panelLabelText('client', 0, running('ACME', 720)), 'ACME 12m');
});

test('panelLabelText: "client" mode paused shows the paused client and its time today', () => {
    assertEqual(panelLabelText('client', 0, paused(720, 'ACME')), 'ACME 12m');
});

test('panelLabelText: "client" mode paused at zero hides', () => {
    assertEqual(panelLabelText('client', 0, paused(0)), '');
});

test('panelLabelText: "client" mode stopped hides even with billed time today', () => {
    assertEqual(panelLabelText('client', 0, stopped(720)), '');
});

test('panelLabelText: "screen" mode ignores paused/stopped and shows the screen total', () => {
    assertEqual(panelLabelText('screen', 720, stopped(60)), '12m');
    assertEqual(panelLabelText('screen', 720, paused(60)), '12m');
});

// --- panelLabelDimmed ---

test('panelLabelDimmed: only "client" mode while paused is faded', () => {
    assertEqual(panelLabelDimmed('client', paused(720)), true);
    assertEqual(panelLabelDimmed('client', running('ACME', 720)), false);
    assertEqual(panelLabelDimmed('client', stopped(720)), false);
    assertEqual(panelLabelDimmed('screen', paused(720)), false);
    assertEqual(panelLabelDimmed('none', paused(720)), false);
});

test('panelLabelText: "none" mode hides even while running with time on the clock', () => {
    assertEqual(panelLabelText('none', 720, running('ACME', 720)), '');
});

test('panelLabelText: "none" mode hides when stopped at zero', () => {
    assertEqual(panelLabelText('none', 0, stopped(0)), '');
});

// --- panelClockState (against a real ClockStore) ---

test('panelClockState: a running session reports its own elapsed time, not the day total', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.stop(t + 1800000);           // ACME: 30 billed minutes, now stopped
    clock.start('BETA', t + 1800000);  // BETA starts the instant ACME stops

    let nowMs = t + 1800000 + 120000;  // BETA has been running 2 minutes
    let state = panelClockState(clock, '2026-09-11', nowMs, false);
    assertEqual(state, { running: true, away: false, paused: false, client: 'BETA', seconds: 120 },
        'must be BETA\'s own 2 minutes, not ACME\'s 30 plus BETA\'s 2');
    clock.destroy();
});

test('panelClockState: a stopped clock reports today\'s billed total across every client', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.start('BETA', t + 1800000);      // closes ACME after 30 billed minutes
    clock.stop(t + 1800000 + 120000);      // closes BETA after 2 billed minutes

    let state = panelClockState(clock, '2026-09-11', t + 3600000, false);
    assertEqual(state, { running: false, away: false, paused: false, client: '', seconds: 1920 },
        '30 ACME minutes + 2 BETA minutes = 1920 seconds');
    clock.destroy();
});

test('panelClockState: nothing clocked today reports zero and running: false', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let state = panelClockState(clock, '2026-09-11', at(2026, 9, 11, 9, 0), false);
    assertEqual(state, { running: false, away: false, paused: false, client: '', seconds: 0 });
    clock.destroy();
});

test('panelClockState: stopped with a client to resume is paused; without one it is not', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.stop(t + 1800000);

    let nowMs = t + 3600000;
    assertEqual(panelClockState(clock, '2026-09-11', nowMs, false, 'ACME').paused, true);
    assertEqual(panelClockState(clock, '2026-09-11', nowMs, false, null).paused, false);
    clock.destroy();
});

test('panelClockState: a paused clock reports the paused client and only its time today', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.start('BETA', t + 1800000);      // closes ACME after 30 minutes
    clock.start('ACME', t + 1800000 + 120000);   // BETA got 2 minutes
    clock.stop(t + 1800000 + 120000 + 600000);   // ACME's second stretch: 10 minutes

    let state = panelClockState(clock, '2026-09-11', t + 7200000, false, 'ACME');
    assertEqual(state, { running: false, away: false, paused: true, client: 'ACME', seconds: 2400 },
        'ACME\'s 30 + 10 minutes, without BETA\'s 2');
    clock.destroy();
});

test('panelClockState: a running clock is never paused, even with a client to resume', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    assertEqual(panelClockState(clock, '2026-09-11', t + 60000, false, 'ACME').paused, false);
    clock.destroy();
});

test('panelClockState: away is passed through unchanged, independent of running state', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let nowMs = at(2026, 9, 11, 9, 0);

    assertEqual(panelClockState(clock, '2026-09-11', nowMs, true).away, true);
    assertEqual(panelClockState(clock, '2026-09-11', nowMs, false).away, false);

    clock.start('ACME', nowMs);
    assertEqual(panelClockState(clock, '2026-09-11', nowMs, true).away, true);
    clock.destroy();
});
