import GLib from 'gi://GLib';
import { test, assert, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import { ClockStore, CLOCK_FILE } from '../src/clockStore.js';
import { readClients, writeClients, activeClients, recentClients } from '../src/clients.js';

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
        { name: 'ACME', active: true, billable: true },
        { name: 'BETA', active: false, billable: false },
    ]);
});

// --- writeClients ---

test('clients: writeClients round-trips through readClients unchanged', () => {
    let settings = new FakeSettings();
    let list = [
        { name: 'ACME', active: true, billable: true },
        { name: 'Personal', active: true, billable: false },
    ];
    writeClients(settings, list);
    assertEqual(readClients(settings), list);
});

// --- activeClients ---

test('clients: activeClients filters out inactive entries regardless of billable', () => {
    let settings = new FakeSettings();
    writeClients(settings, [
        { name: 'ACME', active: true, billable: true },
        { name: 'BETA', active: false, billable: true },  // inactive but billable: still excluded
        { name: 'Personal', active: true, billable: false }, // active but not billable: still included
        { name: 'OldCo', active: false, billable: false },
    ]);
    assertEqual(activeClients(settings), [
        { name: 'ACME', active: true, billable: true },
        { name: 'Personal', active: true, billable: false },
    ]);
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
        { name: 'ACME', active: true, billable: true },   // already present today: not duplicated
        { name: 'BETA', active: true, billable: true },   // already present today: not duplicated
        { name: 'GAMMA', active: true, billable: true },  // padding candidate
        { name: 'DELTA', active: false, billable: true }, // inactive: never used as padding
        { name: 'ZETA', active: true, billable: false },  // padding candidate, non-billable is irrelevant here
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
        { name: 'ACME', active: true, billable: true },
        { name: 'DELTA', active: false, billable: true }, // inactive: never used as padding
    ]);

    let names = recentClients(settings, clock, '2026-09-11', 10);
    assertEqual(names, ['ACME'], 'no blanks, no inactive padding, just the one real client');
    clock.destroy();
});

test('clients: recentClients never uses an inactive client as padding, even with room to pad', () => {
    let settings = new FakeSettings();
    let clock = freshClock(settings);

    writeClients(settings, [
        { name: 'DELTA', active: false, billable: true },
        { name: 'ACME', active: true, billable: true },
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
        { name: 'ACME', active: true, billable: true },
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
        { name: 'GHOST', active: false, billable: true }, // deactivated after being clocked today
        { name: 'ACME', active: true, billable: true },
    ]);

    let names = recentClients(settings, clock, '2026-09-11', 2);
    assertEqual(names, ['GHOST', 'ACME'], 'GHOST has time today and must lead, though it is now inactive');
    clock.destroy();
});
