import GLib from 'gi://GLib';
import { test, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import { ClockStore, CLOCK_FILE } from '../src/clockStore.js';
import { migratePanelSetting, panelLabelText, panelClockState } from '../src/panelMode.js';

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

const stopped = (seconds = 0) => ({ running: false, away: false, client: '', seconds });
const running = (client, seconds) => ({ running: true, away: false, client, seconds });

test('panelLabelText: "screen" mode shows the formatted total when there is time today', () => {
    assertEqual(panelLabelText('screen', 720, stopped()), '12m');
});

test('panelLabelText: "screen" mode hides at zero', () => {
    assertEqual(panelLabelText('screen', 0, stopped()), '');
});

test('panelLabelText: "client" mode running shows the client and elapsed time', () => {
    assertEqual(panelLabelText('client', 0, running('ACME', 720)), 'ACME 12m');
});

test('panelLabelText: "client" mode stopped with billed time today shows the total', () => {
    assertEqual(panelLabelText('client', 0, stopped(720)), '12m');
});

test('panelLabelText: "client" mode stopped at zero hides', () => {
    assertEqual(panelLabelText('client', 0, stopped(0)), '');
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
    assertEqual(state, { running: true, away: false, client: 'BETA', seconds: 120 },
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
    assertEqual(state, { running: false, away: false, client: '', seconds: 1920 },
        '30 ACME minutes + 2 BETA minutes = 1920 seconds');
    clock.destroy();
});

test('panelClockState: nothing clocked today reports zero and running: false', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let state = panelClockState(clock, '2026-09-11', at(2026, 9, 11, 9, 0), false);
    assertEqual(state, { running: false, away: false, client: '', seconds: 0 });
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
