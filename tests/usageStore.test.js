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
