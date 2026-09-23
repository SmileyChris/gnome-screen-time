import { test, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import { getAppNames, setAppName } from '../src/appNames.js';
import { UsageStore, knownAppsFromData } from '../src/usageStore.js';

test('setAppName: sets, and an empty name drops the rename', () => {
    let settings = new FakeSettings();
    setAppName(settings, 'wmclass:foo', 'Foo');
    setAppName(settings, 'b.desktop', 'Bee');
    setAppName(settings, 'b.desktop', '');
    assertEqual(getAppNames(settings), { 'wmclass:foo': 'Foo' });
});

test('renames show under the same id, with the tracked name kept', () => {
    let settings = new FakeSettings();
    let store = new UsageStore(settings);
    store._data = { '2026-09-23': { 'wmclass:foo': { displayName: 'foo', seconds: 60 } } };
    setAppName(settings, 'wmclass:foo', 'Foo App');
    let [app] = store.getUsageForDate('2026-09-23');
    assertEqual([app.appId, app.displayName, app.trackedName],
        ['wmclass:foo', 'Foo App', 'foo']);
    assertEqual([...store.getKnownApps()], [['wmclass:foo', 'Foo App']]);
    store.destroy();
});

test('knownAppsFromData: a renamed "Unknown" app is listed', () => {
    let data = { d: { x: { displayName: 'Unknown', seconds: 1 } } };
    assertEqual([...knownAppsFromData(data)], []);
    assertEqual([...knownAppsFromData(data, { x: 'X' })], [['x', 'X']]);
});
