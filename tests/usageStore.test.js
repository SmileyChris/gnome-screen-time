import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { test, assert, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import {
    UsageStore, todayKeyFor, STORE_FILE, todayKey, dateKey, sortedChildren, OTHER_KEY, MAX_CHILDREN,
} from '../src/usageStore.js';

// Each test starts from an empty file so destroy()'s save in one test cannot
// leak into the next. Returns a store whose initial read has finished.
async function freshStore(settings = new FakeSettings(), fileContents = null) {
    GLib.unlink(STORE_FILE);
    if (fileContents !== null) {
        Gio.File.new_for_path(STORE_FILE).replace_contents(
            new TextEncoder().encode(JSON.stringify(fileContents)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }
    let store = new UsageStore(settings);
    await store.loaded;
    return store;
}

function readStoreFile() {
    let [, contents] = Gio.File.new_for_path(STORE_FILE).load_contents(null);
    return JSON.parse(new TextDecoder().decode(contents));
}

test('addTime: one-level path behaves exactly as before', async () => {
    let store = await freshStore();
    let calls = [];
    store.onChange = (...args) => calls.push(args);
    store.addTime(['a.desktop'], ['A'], 10.4);
    store.addTime(['a.desktop'], ['A'], 5);
    let [entry] = store.getUsageForDate(todayKey());
    assertEqual(entry, { appId: 'a.desktop', displayName: 'A', seconds: 15, children: null });
    assertEqual(calls, [['a.desktop', 'A', 10], ['a.desktop', 'A', 15]]);
    assertEqual(store.getTotalForDate(todayKey()), 15);
    store.destroy();
});

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

function daysAgoKey(n) {
    return dateKey(GLib.DateTime.new_now_local().add_days(-n));
}

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
    settings.emit('changed::purge-requested');
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

// setDirectSeconds: edits a node's own (unbroken-down) time; ancestors follow.
async function editableStore() {
    let store = await freshStore();
    store.addTime(['kgx', 'claude', 'repo-a'], ['Console', 'claude', 'repo-a'], 1200);
    store.addTime(['kgx', 'claude', 'repo-b'], ['Console', 'claude', 'repo-b'], 600);
    store.addTime(['kgx', 'shell'], ['Console', 'shell'], 300);
    store.addTime(['kgx'], ['Console'], 900);   // direct time on the app
    return store;
}

test('setDirectSeconds: leaf edit propagates the delta to every ancestor', async () => {
    let store = await editableStore();
    let changed = 0;
    store.onChange = () => changed++;
    assertEqual(store.setDirectSeconds(todayKey(), ['kgx', 'claude', 'repo-a'], 600), true);
    let [kgx] = store.getUsageForDate(todayKey());
    assertEqual(kgx.seconds, 2400);
    let claude = sortedChildren(kgx.children).find(c => c.id === 'claude');
    assertEqual(claude.seconds, 1200);
    assertEqual(sortedChildren(claude.children).find(c => c.id === 'repo-a').seconds, 600);
    assertEqual(sortedChildren(claude.children).find(c => c.id === 'repo-b').seconds, 600, 'sibling untouched');
    assertEqual(changed, 1);
    store.destroy();
});

test('setDirectSeconds: direct edit on a parent leaves its children alone', async () => {
    let store = await editableStore();
    // Console direct time is 900 (3000 total minus 2100 in children).
    assertEqual(store.setDirectSeconds(todayKey(), ['kgx'], 0), true);
    let [kgx] = store.getUsageForDate(todayKey());
    assertEqual(kgx.seconds, 2100);
    assertEqual(sortedChildren(kgx.children).reduce((s, c) => s + c.seconds, 0), 2100);
    assertEqual(store.setDirectSeconds(todayKey(), ['kgx'], 1800), true, 'increase goes to direct');
    assertEqual(store.getUsageForDate(todayKey())[0].seconds, 3900);
    store.destroy();
});

test('setDirectSeconds: zero removes a leaf and prunes an empty children map', async () => {
    let store = await editableStore();
    store.setDirectSeconds(todayKey(), ['kgx', 'shell'], 0);
    let [kgx] = store.getUsageForDate(todayKey());
    assertEqual(kgx.seconds, 2700);
    assert(!('shell' in kgx.children), 'shell removed');
    store.setDirectSeconds(todayKey(), ['kgx', 'claude', 'repo-a'], 0);
    store.setDirectSeconds(todayKey(), ['kgx', 'claude', 'repo-b'], 0);
    [kgx] = store.getUsageForDate(todayKey());
    assertEqual(kgx.seconds, 900);
    assertEqual(kgx.children, null, 'claude (now 0, no children) and the map are gone');
    store.destroy();
});

test('setDirectSeconds: a level-1 app at zero disappears from the day', async () => {
    let store = await freshStore();
    store.addTime(['a'], ['A'], 100);
    store.addTime(['b'], ['B'], 50);
    store.setDirectSeconds(todayKey(), ['a'], 0);
    assertEqual(store.getUsageForDate(todayKey()).map(e => e.appId), ['b']);
    assertEqual(store.getTotalForDate(todayKey()), 50);
    store.destroy();
});

test('setDirectSeconds: unknown path, unknown day, or unchanged value is a no-op', async () => {
    let store = await editableStore();
    let changed = 0;
    store.onChange = () => changed++;
    assertEqual(store.setDirectSeconds(todayKey(), ['nope'], 5), false);
    assertEqual(store.setDirectSeconds(todayKey(), ['kgx', 'nope'], 5), false);
    assertEqual(store.setDirectSeconds('1999-01-01', ['kgx'], 5), false);
    assertEqual(store.setDirectSeconds(todayKey(), ['kgx'], 900), false, 'same direct value');
    assertEqual(store.setDirectSeconds(todayKey(), ['kgx'], -5), false, 'negative rejected');
    assertEqual(changed, 0);
    assertEqual(store.getUsageForDate(todayKey())[0].seconds, 3000);
    store.destroy();
});

test('setDirectSeconds: edits on a past day survive save and load', async () => {
    let old = dateKey(GLib.DateTime.new_now_local().add_days(-2));
    let store = await freshStore(new FakeSettings(), {
        [old]: { app: { displayName: 'App', seconds: 500, children: { x: { displayName: 'x', seconds: 200 } } } },
    });
    assertEqual(store.setDirectSeconds(old, ['app', 'x'], 50), true);
    assertEqual(store.getUsageForDate(old)[0].seconds, 350);
    store.destroy();
    assertEqual(readStoreFile()[old].app.seconds, 350);
});

test('removeNode: drops a parent and its children, ancestors shrink by its total', async () => {
    let store = await editableStore();
    let changed = 0;
    store.onChange = () => changed++;
    assertEqual(store.removeNode(todayKey(), ['kgx', 'claude']), true);
    let [kgx] = store.getUsageForDate(todayKey());
    assertEqual(kgx.seconds, 1200);
    assertEqual(Object.keys(kgx.children), ['shell']);
    assertEqual(store.removeNode(todayKey(), ['kgx']), true);
    assertEqual(store.getUsageForDate(todayKey()), []);
    assertEqual(store.removeNode(todayKey(), ['kgx']), false, 'already gone');
    assertEqual(changed, 2);
    store.destroy();
});

test('undo: restores the day as it was before the last edit, once', async () => {
    let store = await editableStore();
    assertEqual(store.canUndo(todayKey()), false);
    store.setDirectSeconds(todayKey(), ['kgx', 'claude', 'repo-a'], 0);
    store.removeNode(todayKey(), ['kgx', 'shell']);
    assertEqual(store.canUndo(todayKey()), true, 'snapshot from before the first edit is replaced by the second');
    let changed = 0;
    store.onChange = () => changed++;
    assertEqual(store.undo(todayKey()), true);
    let [kgx] = store.getUsageForDate(todayKey());
    assertEqual(kgx.seconds, 1800, 'shell is back, repo-a stays deleted (one level of undo)');
    assert('shell' in kgx.children);
    assertEqual(store.canUndo(todayKey()), false);
    assertEqual(store.undo(todayKey()), false);
    assertEqual(changed, 1);
    store.destroy();
});

test('undo: is per day and survives an unrelated addTime on another day', async () => {
    let old = dateKey(GLib.DateTime.new_now_local().add_days(-1));
    let store = await freshStore(new FakeSettings(), {
        [old]: { app: { displayName: 'App', seconds: 500 } },
    });
    store.setDirectSeconds(old, ['app'], 100);
    store.addTime(['x'], ['X'], 5);
    assertEqual(store.canUndo(todayKey()), false);
    assertEqual(store.canUndo(old), true);
    store.undo(old);
    assertEqual(store.getUsageForDate(old)[0].seconds, 500);
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
