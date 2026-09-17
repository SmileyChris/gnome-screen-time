import { test, assertEqual } from './harness.js';
import { FakeSettings } from './fakeSettings.js';
import { getAppLimits, setAppLimit, removeAppLimit } from '../src/appLimits.js';

test('getAppLimits: unpacks the key into a plain object', () => {
    let settings = new FakeSettings({}, { 'a.desktop': 30 });
    assertEqual(getAppLimits(settings), { 'a.desktop': 30 });
});

test('getAppLimits: no limits set reads as an empty object', () => {
    assertEqual(getAppLimits(new FakeSettings()), {});
});

test('setAppLimit: adds one without disturbing the others', () => {
    let settings = new FakeSettings({}, { 'a.desktop': 30 });
    setAppLimit(settings, 'b.desktop', 45);
    assertEqual(getAppLimits(settings), { 'a.desktop': 30, 'b.desktop': 45 });
});

test('setAppLimit: an existing app is overwritten, not doubled up', () => {
    let settings = new FakeSettings({}, { 'a.desktop': 30 });
    setAppLimit(settings, 'a.desktop', 60);
    assertEqual(getAppLimits(settings), { 'a.desktop': 60 });
});

test('removeAppLimit: drops one and leaves the rest', () => {
    let settings = new FakeSettings({}, { 'a.desktop': 30, 'b.desktop': 45 });
    removeAppLimit(settings, 'a.desktop');
    assertEqual(getAppLimits(settings), { 'b.desktop': 45 });
});

test('removeAppLimit: an app with no limit is a no-op', () => {
    let settings = new FakeSettings({}, { 'a.desktop': 30 });
    removeAppLimit(settings, 'nothere.desktop');
    assertEqual(getAppLimits(settings), { 'a.desktop': 30 });
});

test('writes go through the settings key, so every reader sees them', () => {
    let settings = new FakeSettings();
    let seen = null;
    settings.connect('changed::app-limits', s => { seen = getAppLimits(s); });
    setAppLimit(settings, 'a.desktop', 15);
    assertEqual(seen, { 'a.desktop': 15 });
});
