import { test, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import { migratePanelSetting, panelLabelText } from '../src/panelMode.js';

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
