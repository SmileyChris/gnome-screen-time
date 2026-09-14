import GLib from 'gi://GLib';
import { test, assert, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import { ClockStore, CLOCK_FILE } from '../src/clockStore.js';
import { readClients, writeClients, activeClients, recentClients, isKnownClient, pausedClient } from '../src/clients.js';

function at(y, mo, d, h, mi = 0) {
    return GLib.DateTime.new_local(y, mo, d, h, mi, 0).to_unix() * 1000;
}

function freshClock(settings = new FakeSettings()) {
    GLib.unlink(CLOCK_FILE);
    return new ClockStore(settings);
}

// --- readClients ---

test('clients: readClients on an empty key returns []', () => {
    let settings = new FakeSettings();
    assertEqual(readClients(settings), []);
});

test('clients: readClients on a populated key returns objects in stored order', () => {
    let settings = new FakeSettings();
    settings.set_value('clients', new GLib.Variant('a(sbb)', [
        ['ACME', true, true],
        ['BETA', false, false],
    ]));
    assertEqual(readClients(settings), [
        { name: 'ACME', active: true },
        { name: 'BETA', active: false },
    ], 'the stored third value (the old billable flag) is ignored');
});

// --- writeClients ---

test('clients: writeClients round-trips through readClients unchanged', () => {
    let settings = new FakeSettings();
    let list = [
        { name: 'ACME', active: true },
        { name: 'Personal', active: false },
    ];
    writeClients(settings, list);
    assertEqual(readClients(settings), list);
});

test('clients: writeClients keeps the stored a(sbb) shape, with true as the unused third value', () => {
    let settings = new FakeSettings();
    writeClients(settings, [{ name: 'ACME', active: false }]);
    assertEqual(settings.get_value('clients').deepUnpack(), [['ACME', false, true]]);
});

// --- activeClients ---

test('clients: activeClients filters out inactive entries', () => {
    let settings = new FakeSettings();
    writeClients(settings, [
        { name: 'ACME', active: true },
        { name: 'BETA', active: false },
        { name: 'Personal', active: true },
    ]);
    assertEqual(activeClients(settings), [
        { name: 'ACME', active: true },
        { name: 'Personal', active: true },
    ]);
});

// --- isKnownClient ---

test('isKnownClient: true for a client on the list, active or not', () => {
    let settings = new FakeSettings();
    writeClients(settings, [
        { name: 'ACME', active: true },
        { name: 'OldCo', active: false },
    ]);
    assertEqual(isKnownClient(settings, 'ACME'), true);
    assertEqual(isKnownClient(settings, 'OldCo'), true, 'inactive is still known - only delete removes it');
});

test('isKnownClient: false for a name not on the list at all', () => {
    let settings = new FakeSettings();
    writeClients(settings, [{ name: 'ACME', active: true }]);
    assertEqual(isKnownClient(settings, 'Ghost'), false);
});

test('isKnownClient: false for an empty name', () => {
    let settings = new FakeSettings();
    writeClients(settings, [{ name: 'ACME', active: true }]);
    assertEqual(isKnownClient(settings, ''), false);
});

test('isKnownClient: false against an empty client list', () => {
    let settings = new FakeSettings();
    assertEqual(isKnownClient(settings, 'ACME'), false);
});

// --- pausedClient ---

test('pausedClient: last-client when nothing is running and it is still on the list', () => {
    let settings = new FakeSettings();
    writeClients(settings, [{ name: 'ACME', active: true }]);
    settings.set_string('last-client', 'ACME');
    assertEqual(pausedClient(settings, null), 'ACME');
});

test('pausedClient: null while a session is running, whoever last-client names', () => {
    let settings = new FakeSettings();
    writeClients(settings, [{ name: 'ACME', active: true }]);
    settings.set_string('last-client', 'ACME');
    assertEqual(pausedClient(settings, { client: 'ACME' }), null);
});

test('pausedClient: null once stopped, since stop empties last-client', () => {
    let settings = new FakeSettings();
    writeClients(settings, [{ name: 'ACME', active: true }]);
    assertEqual(pausedClient(settings, null), null);
});

test('pausedClient: null when last-client was deleted from the list', () => {
    let settings = new FakeSettings();
    writeClients(settings, [{ name: 'ACME', active: true }]);
    settings.set_string('last-client', 'Ghost');
    assertEqual(pausedClient(settings, null), null);
});

// --- recentClients ---

test('clients: recentClients lists today\'s clients first, in first-use order', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.start('BETA', t + 3600000);      // closes ACME, opens BETA
    clock.start('ACME', t + 7200000);      // closes BETA, reopens ACME
    clock.stop(t + 10800000);

    let names = recentClients(settings, clock, '2026-09-11', 2);
    assertEqual(names, ['ACME', 'BETA'], 'first-use order, not alphabetical or reverse');
    clock.destroy();
});

test('clients: recentClients de-duplicates a client clocked twice today', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.start('BETA', t + 3600000);
    clock.start('ACME', t + 7200000);
    clock.stop(t + 10800000);

    let names = recentClients(settings, clock, '2026-09-11', 0);
    assertEqual(names.filter(n => n === 'ACME').length, 1, 'ACME appears once despite two sessions');
    clock.destroy();
});

test('clients: recentClients pads from the active list to reach min, skipping duplicates and inactive clients', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.start('BETA', t + 3600000);
    clock.stop(t + 7200000);

    writeClients(settings, [
        { name: 'ACME', active: true },   // already present today: not duplicated
        { name: 'BETA', active: true },   // already present today: not duplicated
        { name: 'GAMMA', active: true },  // padding candidate
        { name: 'DELTA', active: false }, // inactive: never used as padding
        { name: 'ZETA', active: true },                   // padding candidate
    ]);

    let names = recentClients(settings, clock, '2026-09-11', 4);
    assertEqual(names, ['ACME', 'BETA', 'GAMMA', 'ZETA']);
    clock.destroy();
});

test('clients: recentClients yields a shorter list than min when the active list runs out', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('ACME', t);
    clock.stop(t + 3600000);

    writeClients(settings, [
        { name: 'ACME', active: true },
        { name: 'DELTA', active: false }, // inactive: never used as padding
    ]);

    let names = recentClients(settings, clock, '2026-09-11', 10);
    assertEqual(names, ['ACME'], 'no blanks, no inactive padding, just the one real client');
    clock.destroy();
});

test('clients: recentClients never uses an inactive client as padding, even with room to pad', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);

    writeClients(settings, [
        { name: 'DELTA', active: false },
        { name: 'ACME', active: true },
    ]);

    let names = recentClients(settings, clock, '2026-09-11', 5);
    assertEqual(names, ['ACME']);
    clock.destroy();
});

// A client clocked today only ever comes from sessionsForDay(), never from
// the client list: it must still show up even after being deleted or
// deactivated, since it has time logged against it today regardless of its
// current standing in Clients preferences.

test('clients: recentClients lists a client clocked today that has since been deleted from the client list', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('GHOST', t);
    clock.stop(t + 3600000);

    // GHOST never appears in the client list at all - as if removed.
    writeClients(settings, [
        { name: 'ACME', active: true },
    ]);

    let names = recentClients(settings, clock, '2026-09-11', 2);
    assertEqual(names, ['GHOST', 'ACME'], 'GHOST has time today and must lead, though it is not a known client');
    clock.destroy();
});

test('clients: recentClients lists a client clocked today that has since been made inactive', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);
    let t = at(2026, 9, 11, 9, 0);
    clock.start('GHOST', t);
    clock.stop(t + 3600000);

    writeClients(settings, [
        { name: 'GHOST', active: false }, // deactivated after being clocked today
        { name: 'ACME', active: true },
    ]);

    let names = recentClients(settings, clock, '2026-09-11', 2);
    assertEqual(names, ['GHOST', 'ACME'], 'GHOST has time today and must lead, though it is now inactive');
    clock.destroy();
});
