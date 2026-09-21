import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { test, assert, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import {
    UsageStore, STORE_FILE, todayKey, todayKeyFor, dateKey, knownAppsFromData,
    sortedChildren, OTHER_KEY, MAX_CHILDREN,
} from '../src/usageStore.js';

function daysAgoKey(days) {
    return dateKey(GLib.DateTime.new_now_local().add_days(-days));
}

function writeStoreFile(data) {
    Gio.File.new_for_path(STORE_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify(data)),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

function readStoreFile() {
    let [, contents] = Gio.File.new_for_path(STORE_FILE).load_contents(null);
    return JSON.parse(new TextDecoder().decode(contents));
}

// The initial read is asynchronous and fire-and-forget: the store announces it
// has landed by calling onChange with no arguments, where addTime always names
// the app it credited. Waiting for the argument-less call is how a test knows
// the store is ready without reaching into its internals.
function whenLoaded(store) {
    return new Promise(resolve => {
        store.onChange = (...args) => {
            if (args.length > 0)
                return;
            store.onChange = null;
            resolve();
        };
    });
}

// Each test starts from a known file, so the save in one test's destroy()
// cannot leak into the next.
async function freshStore(settings = new FakeSettings(), fileContents = null) {
    GLib.unlink(STORE_FILE);
    if (fileContents !== null)
        writeStoreFile(fileContents);
    let store = new UsageStore(settings);
    await whenLoaded(store);
    return store;
}

test('addTime: accumulates per app and reports the running total', async () => {
    let store = await freshStore();
    let calls = [];
    store.onChange = (...args) => calls.push(args);
    store.addTime(['a.desktop'], ['A'], 10);
    store.addTime(['a.desktop'], ['A'], 5);
    assertEqual(store.getUsageForDate(todayKey()),
        [{ appId: 'a.desktop', displayName: 'A', seconds: 15, children: null }]);
    assertEqual(calls, [['a.desktop', 'A', 10], ['a.desktop', 'A', 15]]);
    store.destroy();
});

test('addTime: each credit is rounded as it lands', async () => {
    let store = await freshStore();
    store.addTime(['a.desktop'], ['A'], 10.4);
    store.addTime(['a.desktop'], ['A'], 10.6);
    assertEqual(store.getTotalForDate(todayKey()), 21);
    store.destroy();
});

test('addTime: a renamed app keeps its time under the same id', async () => {
    let store = await freshStore();
    store.addTime(['a.desktop'], ['Old Name'], 10);
    store.addTime(['a.desktop'], ['New Name'], 10);
    assertEqual(store.getUsageForDate(todayKey()),
        [{ appId: 'a.desktop', displayName: 'New Name', seconds: 20, children: null }]);
    store.destroy();
});

test('getUsageForDate: biggest first, and empty for a day with nothing', async () => {
    let store = await freshStore();
    store.addTime(['small.desktop'], ['Small'], 5);
    store.addTime(['big.desktop'], ['Big'], 50);
    store.addTime(['mid.desktop'], ['Mid'], 20);
    assertEqual(store.getUsageForDate(todayKey()).map(e => e.appId),
        ['big.desktop', 'mid.desktop', 'small.desktop']);
    assertEqual(store.getUsageForDate('1999-01-01'), []);
    store.destroy();
});

test('totals: the day total is the sum of its apps', async () => {
    let yesterday = daysAgoKey(1);
    let store = await freshStore(new FakeSettings(), {
        [yesterday]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
    });
    store.addTime(['a.desktop'], ['A'], 10);
    store.addTime(['b.desktop'], ['B'], 20);
    assertEqual(store.getTodayTotal(), 30);
    assertEqual(store.getTotalForDate(yesterday), 60);
    assertEqual(store.getTotalForDate('1999-01-01'), 0);
    store.destroy();
});

test('getOldestDate: how far back the UI may page, null when empty', async () => {
    let store = await freshStore();
    assertEqual(store.getOldestDate(), null);
    store.destroy();

    let older = daysAgoKey(3);
    let store2 = await freshStore(new FakeSettings(), {
        [daysAgoKey(1)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
        [older]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
    });
    assertEqual(store2.getOldestDate(), older);
    store2.destroy();
});

test('knownAppsFromData: every app across every day, minus Unknown', () => {
    let known = knownAppsFromData({
        '2026-01-01': {
            'a.desktop': { displayName: 'A', seconds: 10 },
            'window:1': { displayName: 'Unknown', seconds: 10 },
        },
        '2026-01-02': { 'b.desktop': { displayName: 'B', seconds: 10 } },
    });
    assertEqual([...known], [['a.desktop', 'A'], ['b.desktop', 'B']]);
});

test('getKnownApps: reads the live data through the same filter', async () => {
    let store = await freshStore();
    store.addTime(['a.desktop'], ['A'], 10);
    store.addTime(['window:1'], ['Unknown'], 10);
    assertEqual([...store.getKnownApps()], [['a.desktop', 'A']]);
    store.destroy();
});

test('retention: days past the setting are dropped when it changes', async () => {
    let settings = new FakeSettings({ 'retention-days': 90 });
    let store = await freshStore(settings, {
        [daysAgoKey(100)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
        [daysAgoKey(3)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
    });
    assertEqual(store.getOldestDate(), daysAgoKey(3),
        'the load-time cleanup already applied the 90-day setting');

    settings.set_int('retention-days', 2);
    assertEqual(store.getOldestDate(), null, 'the shorter setting takes effect at once');
    store.destroy();
});

test('retention: 0 keeps everything', async () => {
    let store = await freshStore(new FakeSettings({ 'retention-days': 0 }), {
        [daysAgoKey(1000)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
    });
    assertEqual(store.getOldestDate(), daysAgoKey(1000));
    store.destroy();
});

test('purge: the manual trigger clears anything older than a week', async () => {
    let settings = new FakeSettings({ 'retention-days': 0 });
    let store = await freshStore(settings, {
        [daysAgoKey(30)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
        [daysAgoKey(3)]: { 'a.desktop': { displayName: 'A', seconds: 60 } },
    });
    let notified = 0;
    store.onChange = () => notified++;

    settings.set_int('purge-requested', 1);
    assertEqual(store.getOldestDate(), daysAgoKey(3));
    assertEqual(notified, 1, 'the UI is told to redraw');
    assertEqual(Object.keys(readStoreFile()), [daysAgoKey(3)],
        'a purge is written out immediately, not left to the next autosave');
    store.destroy();
});

test('destroy: banks the day to disk, and the next store reads it back', async () => {
    let store = await freshStore();
    store.addTime(['a.desktop'], ['A'], 42);
    store.destroy();
    assertEqual(readStoreFile(),
        { [todayKey()]: { 'a.desktop': { displayName: 'A', seconds: 42 } } });

    let reopened = new UsageStore(new FakeSettings());
    await whenLoaded(reopened);
    assertEqual(reopened.getTodayTotal(), 42);
    reopened.destroy();
});

test('load: time tracked before the read lands is added to it, not lost', async () => {
    GLib.unlink(STORE_FILE);
    writeStoreFile({
        [todayKey()]: {
            'a.desktop': { displayName: 'A', seconds: 60 },
            'b.desktop': { displayName: 'B', seconds: 60 },
        },
    });

    let store = new UsageStore(new FakeSettings());
    let loaded = whenLoaded(store);
    // Racing the read, exactly as a focus change during startup would.
    store.addTime(['a.desktop'], ['A'], 5);
    store.addTime(['c.desktop'], ['C'], 5);
    await loaded;

    assertEqual(store.getUsageForDate(todayKey()), [
        { appId: 'a.desktop', displayName: 'A', seconds: 65, children: null },
        { appId: 'b.desktop', displayName: 'B', seconds: 60, children: null },
        { appId: 'c.desktop', displayName: 'C', seconds: 5, children: null },
    ]);
    store.destroy();
});

test('save: a store torn down before the read lands writes nothing', async () => {
    let stored = { [todayKey()]: { 'a.desktop': { displayName: 'A', seconds: 60 } } };
    GLib.unlink(STORE_FILE);
    writeStoreFile(stored);

    // Enabled and disabled again inside the same second: the read is still in
    // flight when destroy() saves. Those 10 seconds are dropped on purpose,
    // because writing them would take the whole stored day with them.
    let store = new UsageStore(new FakeSettings());
    store.addTime(['b.desktop'], ['B'], 10);
    store.destroy();

    assertEqual(readStoreFile(), stored,
        'saving unloaded data would clobber the history it never read');
});

test('addTime: a sub-second focus blink is not recorded as an app', async () => {
    let store = await freshStore();
    let calls = [];
    store.onChange = (...args) => calls.push(args);

    store.addTime(['blink.desktop'], ['Unknown'], 0.4);

    assertEqual(store.getUsageForDate(todayKey()), [],
        'a credit that rounds to zero must not create a row');
    assertEqual(calls, [], 'and must not announce a change');
    store.destroy();
});

test('addTime: sub-second blinks never mask a real credit', async () => {
    let store = await freshStore();
    store.addTime(['a.desktop'], ['A'], 0.4);
    store.addTime(['a.desktop'], ['A'], 90);
    assertEqual(store.getTotalForDate(todayKey()), 90);
    store.destroy();
});

test('load: zero-second rows written by older versions are swept out', async () => {
    let store = await freshStore(new FakeSettings(), {
        [todayKey()]: {
            'a.desktop': { displayName: 'A', seconds: 60 },
            'window:1': { displayName: 'Unknown', seconds: 0 },
        },
        [daysAgoKey(1)]: {
            'window:2': { displayName: 'Unknown', seconds: 0 },
        },
    });

    assertEqual(store.getUsageForDate(todayKey()),
        [{ appId: 'a.desktop', displayName: 'A', seconds: 60, children: null }]);
    assertEqual(store.getTotalForDate(todayKey()), 60, 'no total moves');
    assertEqual(store.getOldestDate(), todayKey(),
        'a day left with nothing in it is dropped too');
    store.destroy();
});

// The day boundary. dateKey() takes the hour and subtracts it before reading
// the date, so DST is GLib's problem: NZ's spring-forward day is 23 hours long
// and its fall-back day 25, and neither should move a night's work.
const at = (y, m, d, h, min) => GLib.DateTime.new_local(y, m, d, h, min, 0);

test('dateKey: hour 0 is the plain calendar day', () => {
    assertEqual(dateKey(at(2026, 9, 24, 1, 30), 0), '2026-09-24');
    assertEqual(dateKey(at(2026, 9, 24, 1, 30)), '2026-09-24', 'and is the default');
});

test('dateKey: before the boundary belongs to the day before', () => {
    assertEqual(dateKey(at(2026, 9, 24, 1, 30), 4), '2026-09-23');
    assertEqual(dateKey(at(2026, 9, 24, 3, 59), 4), '2026-09-23');
});

test('dateKey: the boundary hour starts the new day', () => {
    assertEqual(dateKey(at(2026, 9, 24, 4, 0), 4), '2026-09-24');
    assertEqual(dateKey(at(2026, 9, 24, 12, 0), 4), '2026-09-24');
    assertEqual(dateKey(at(2026, 9, 24, 23, 59), 4), '2026-09-24');
});

test('dateKey: a 23-hour day (DST spring forward) keeps its night', () => {
    assertEqual(dateKey(at(2026, 9, 27, 1, 30), 4), '2026-09-26');
    assertEqual(dateKey(at(2026, 9, 27, 5, 0), 4), '2026-09-27');
});

test('dateKey: a 25-hour day (DST fall back) keeps its night', () => {
    assertEqual(dateKey(at(2026, 4, 5, 1, 30), 4), '2026-04-04');
    assertEqual(dateKey(at(2026, 4, 5, 6, 0), 4), '2026-04-05');
});

test('todayKeyFor: reads the boundary out of settings', () => {
    let settings = new FakeSettings({ 'day-start-hour': 0 });
    assertEqual(todayKeyFor(settings), todayKey(0));
    settings.set_int('day-start-hour', 23);
    assertEqual(todayKeyFor(settings), todayKey(23));
});

test('a day key shifted by whole days is never offset again', () => {
    // shiftKey() in the popup walks between keys that are already logical
    // days; running those back through the boundary would move every one.
    let key = dateKey(at(2026, 9, 24, 1, 30), 4);
    let [y, m, d] = key.split('-').map(Number);
    assertEqual(dateKey(GLib.DateTime.new_local(y, m, d, 0, 0, 0)), key);
});

// Nested paths: [appId], [appId, activityId] or [appId, activityId, detailId].

test('addTime: three-level path credits every ancestor', async () => {
    let store = await freshStore();
    store.addTime(['kgx', 'claude', 'repo-a'], ['Console', 'claude', 'repo-a'], 30);
    store.addTime(['kgx', 'claude', 'repo-b'], ['Console', 'claude', 'repo-b'], 20);
    store.addTime(['kgx', 'shell'], ['Console', 'shell'], 10);
    store.addTime(['kgx'], ['Console'], 5);
    let [entry] = store.getUsageForDate(todayKey());
    assertEqual(entry.seconds, 65, 'level 1 is the sum of everything below it');
    assertEqual(store.getTotalForDate(todayKey()), 65, 'day total reads level 1 only');
    let level2 = sortedChildren(entry.children);
    assertEqual(level2.map(c => [c.id, c.seconds]), [['claude', 50], ['shell', 10]]);
    assertEqual(level2[0].displayName, 'claude');
    let level3 = sortedChildren(level2[0].children);
    assertEqual(level3.map(c => [c.id, c.seconds]), [['repo-a', 30], ['repo-b', 20]]);
    assertEqual(sortedChildren(level2[1].children), [], 'shell has no details');
    store.destroy();
});

test('addTime: onChange reports level-1 seconds for a deep path', async () => {
    let store = await freshStore();
    let calls = [];
    store.onChange = (...args) => calls.push(args);
    store.addTime(['kgx', 'claude', 'repo'], ['Console', 'claude', 'repo'], 30);
    assertEqual(calls, [['kgx', 'Console', 30]]);
    store.destroy();
});

test('getUsageForDate: sorted biggest first at level 1, children carried along', async () => {
    let store = await freshStore();
    store.addTime(['small'], ['Small'], 5);
    store.addTime(['big', 'x'], ['Big', 'x'], 50);
    let entries = store.getUsageForDate(todayKey());
    assertEqual(entries.map(e => e.appId), ['big', 'small']);
    assertEqual(Object.keys(entries[0].children), ['x']);
    assertEqual(entries[1].children, null);
    store.destroy();
});

test('sortedChildren: missing map is an empty list', () => {
    assertEqual(sortedChildren(null), []);
    assertEqual(sortedChildren(undefined), []);
});

test('getKnownApps: reads level 1 only', async () => {
    let store = await freshStore();
    store.addTime(['kgx', 'claude', 'repo'], ['Console', 'claude', 'repo'], 30);
    assertEqual([...store.getKnownApps()], [['kgx', 'Console']]);
    store.destroy();
});

test('fold: the 21st named child folds the smallest sibling into __other__', async () => {
    let store = await freshStore();
    for (let i = 0; i < MAX_CHILDREN; i++)
        store.addTime(['kgx', 'claude', `repo-${i}`], ['Console', 'claude', `repo-${i}`], 100 + i);
    // repo-0 (100s) is the smallest and gets folded to make room.
    store.addTime(['kgx', 'claude', 'repo-new'], ['Console', 'claude', 'repo-new'], 7);

    let [entry] = store.getUsageForDate(todayKey());
    let details = sortedChildren(sortedChildren(entry.children)[0].children);
    let named = details.filter(d => d.id !== OTHER_KEY);
    let other = details.find(d => d.id === OTHER_KEY);

    assertEqual(named.length, MAX_CHILDREN);
    assert(!named.some(d => d.id === 'repo-0'), 'repo-0 was folded');
    assert(named.some(d => d.id === 'repo-new'), 'the newcomer got a slot');
    assertEqual(other.seconds, 100);
    assertEqual(other.count, 1);
    assertEqual(other.displayName, 'Other');

    let sum = details.reduce((s, d) => s + d.seconds, 0);
    assertEqual(sum, sortedChildren(entry.children)[0].seconds, 'details reconcile with activity');
    store.destroy();
});

test('fold: repeated overflow accumulates into one __other__ node', async () => {
    let store = await freshStore();
    for (let i = 0; i < MAX_CHILDREN + 3; i++)
        store.addTime(['kgx', 'claude', `r${i}`], ['Console', 'claude', `r${i}`], 10);
    let [entry] = store.getUsageForDate(todayKey());
    let details = sortedChildren(sortedChildren(entry.children)[0].children);
    let other = details.find(d => d.id === OTHER_KEY);
    assertEqual(details.length, MAX_CHILDREN + 1, '20 named plus one other');
    assertEqual(other.count, 3);
    assertEqual(other.seconds, 30);
    store.destroy();
});

test('fold: crediting an existing child never triggers a fold', async () => {
    let store = await freshStore();
    for (let i = 0; i < MAX_CHILDREN; i++)
        store.addTime(['kgx', `cmd-${i}`], ['Console', `cmd-${i}`], 10);
    store.addTime(['kgx', 'cmd-3'], ['Console', 'cmd-3'], 10);
    let [entry] = store.getUsageForDate(todayKey());
    assert(!(OTHER_KEY in entry.children), 'no other node');
    assertEqual(entry.children['cmd-3'].seconds, 20);
    store.destroy();
});

test('fold: level 1 is not capped', async () => {
    let store = await freshStore();
    for (let i = 0; i < MAX_CHILDREN + 5; i++)
        store.addTime([`app-${i}`], [`App ${i}`], 10);
    assertEqual(store.getUsageForDate(todayKey()).length, MAX_CHILDREN + 5);
    store.destroy();
});

test('load: a file written by the current version loads unchanged', async () => {
    let today = todayKey();
    let store = await freshStore(new FakeSettings(), {
        [today]: {
            'a.desktop': { displayName: 'A', seconds: 120 },
            'b.desktop': { displayName: 'B', seconds: 30 },
        },
    });
    assertEqual(store.getUsageForDate(today), [
        { appId: 'a.desktop', displayName: 'A', seconds: 120, children: null },
        { appId: 'b.desktop', displayName: 'B', seconds: 30, children: null },
    ]);
    // Adding a sub-path to a flat node grows children in place.
    store.addTime(['a.desktop', 'x'], ['A', 'x'], 10);
    let [a] = store.getUsageForDate(today);
    assertEqual(a.seconds, 130);
    assertEqual(sortedChildren(a.children), [
        { id: 'x', displayName: 'x', seconds: 10, count: 0, children: null },
    ]);
    store.destroy();
});

test('load: nested file round-trips through save and load', async () => {
    let today = todayKey();
    let store = await freshStore();
    store.addTime(['kgx', 'claude', 'repo'], ['Console', 'claude', 'repo'], 30);
    store.destroy();   // saves

    let onDisk = readStoreFile();
    assertEqual(onDisk[today].kgx.children.claude.children.repo.seconds, 30);
    assertEqual(onDisk[today].kgx.seconds, 30, 'old versions read level 1 as plain data');

    let reloaded = new UsageStore(new FakeSettings());
    await reloaded.loaded;
    let [entry] = reloaded.getUsageForDate(today);
    assertEqual(sortedChildren(sortedChildren(entry.children)[0].children)[0].id, 'repo');
    reloaded.destroy();
});

test('merge: time tracked before the read lands is added under nested data', async () => {
    let today = todayKey();
    GLib.unlink(STORE_FILE);
    Gio.File.new_for_path(STORE_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify({
            [today]: {
                kgx: {
                    displayName: 'Console', seconds: 100,
                    children: {
                        claude: {
                            displayName: 'claude', seconds: 100,
                            children: { repo: { displayName: 'repo', seconds: 100 } },
                        },
                    },
                },
            },
        })),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let store = new UsageStore(new FakeSettings());
    // Before `loaded` resolves: simulates the tracker firing during the read.
    store.addTime(['kgx', 'claude', 'repo'], ['Console', 'claude', 'repo'], 5);
    store.addTime(['kgx', 'shell'], ['Console', 'shell'], 2);
    await store.loaded;

    let [entry] = store.getUsageForDate(today);
    assertEqual(entry.seconds, 107);
    let l2 = sortedChildren(entry.children);
    assertEqual(l2.map(c => [c.id, c.seconds]), [['claude', 105], ['shell', 2]]);
    assertEqual(sortedChildren(l2[0].children)[0].seconds, 105);
    store.destroy();
});

test('retention: old nested days are dropped, today kept intact', async () => {
    let today = todayKey();
    let old = daysAgoKey(30);
    let nested = {
        displayName: 'Console', seconds: 50,
        children: { claude: { displayName: 'claude', seconds: 50 } },
    };
    let store = await freshStore(new FakeSettings({ 'retention-days': 7 }), {
        [old]: { kgx: nested },
        [today]: { kgx: nested },
    });
    assertEqual(store.getUsageForDate(old), []);
    assertEqual(store.getOldestDate(), today);
    assertEqual(sortedChildren(store.getUsageForDate(today)[0].children)[0].seconds, 50);
    store.destroy();
});

test('purge: purge-requested deletes days older than 7 over nested data', async () => {
    let today = todayKey();
    let settings = new FakeSettings({ 'retention-days': 90 });
    let store = await freshStore(settings, {
        [daysAgoKey(10)]: { kgx: { displayName: 'Console', seconds: 5,
            children: { x: { displayName: 'x', seconds: 5 } } } },
        [daysAgoKey(3)]: { kgx: { displayName: 'Console', seconds: 6 } },
        [today]: { kgx: { displayName: 'Console', seconds: 7 } },
    });
    let changed = 0;
    store.onChange = () => changed++;
    settings.set_int('purge-requested', 1);
    assertEqual(store.getOldestDate(), daysAgoKey(3));
    assertEqual(changed, 1);
    assertEqual(Object.keys(readStoreFile()).sort(), [daysAgoKey(3), today].sort(),
        'purge saves immediately');
    store.destroy();
});

test('merge: a late file cannot leave a parent above MAX_CHILDREN', async () => {
    let today = todayKey();
    let onDisk = {};
    for (let i = 0; i < MAX_CHILDREN; i++)
        onDisk[`d${i}`] = { displayName: `d${i}`, seconds: 100 + i };
    GLib.unlink(STORE_FILE);
    Gio.File.new_for_path(STORE_FILE).replace_contents(
        new TextEncoder().encode(JSON.stringify({
            [today]: { kgx: { displayName: 'Console', seconds: 2190, children: onDisk } },
        })),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

    let store = new UsageStore(new FakeSettings());
    // Two brand-new children tracked while the read is in flight.
    store.addTime(['kgx', 'fresh-a'], ['Console', 'fresh-a'], 3);
    store.addTime(['kgx', 'fresh-b'], ['Console', 'fresh-b'], 4);
    await store.loaded;

    let [entry] = store.getUsageForDate(today);
    let children = sortedChildren(entry.children);
    let named = children.filter(c => c.id !== OTHER_KEY);
    let other = children.find(c => c.id === OTHER_KEY);
    assertEqual(named.length, MAX_CHILDREN, 'cap holds after merge');
    assertEqual(other.count, 2, 'two smallest were folded');
    assertEqual(other.seconds, 7, 'fresh-a and fresh-b, the smallest, were folded');
    assertEqual(entry.seconds, 2197);
    let sum = children.reduce((s, c) => s + c.seconds, 0);
    assertEqual(sum, entry.seconds, 'children still reconcile with the parent');
    store.destroy();
});
