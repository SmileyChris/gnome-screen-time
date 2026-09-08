import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { test, assert, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import {
    UsageStore, STORE_FILE, todayKey, dateKey, sortedChildren, OTHER_KEY, MAX_CHILDREN,
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
