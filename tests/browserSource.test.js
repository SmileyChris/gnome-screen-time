import { test, assert, assertEqual } from './harness.js';
import { BrowserSource, BROWSER_APP_IDS, BROWSERS } from '../src/browserSource.js';

test('browserSource: claims exactly the two browser app ids', () => {
    let s = new BrowserSource();
    assert(s.claims('brave-browser.desktop'));
    assert(s.claims('zen.desktop'));
    assert(!s.claims('firefox.desktop'));
    assert(!s.claims('org.gnome.Console.desktop'));
    assertEqual(Object.values(BROWSER_APP_IDS).sort(), [...BROWSERS].sort());
});

test('browserSource: no state resolves to null', async () => {
    let s = new BrowserSource();
    assertEqual(await s.resolve({}, 'brave-browser.desktop'), null);
});

test('browserSource: state is per browser and maps to a sub-path', async () => {
    let s = new BrowserSource();
    s.setState('brave', 'github.com', 'anthropics/claude-code');
    s.setState('zen', 'reddit.com', 'r/gnome');
    assertEqual(await s.resolve({}, 'brave-browser.desktop'), {
        activityId: 'github.com', activityName: 'github.com',
        detailId: 'anthropics/claude-code', detailName: 'anthropics/claude-code',
    });
    assertEqual(await s.resolve({}, 'zen.desktop'), {
        activityId: 'reddit.com', activityName: 'reddit.com',
        detailId: 'r/gnome', detailName: 'r/gnome',
    });
});

test('browserSource: empty detail is two levels; empty host is no breakdown', async () => {
    let s = new BrowserSource();
    s.setState('brave', 'example.com', '');
    assertEqual(await s.resolve({}, 'brave-browser.desktop'), {
        activityId: 'example.com', activityName: 'example.com', detailId: null, detailName: null,
    });
    s.setState('brave', '', '');
    assertEqual(await s.resolve({}, 'brave-browser.desktop'), null);
});

test('browserSource: unknown browser is ignored', async () => {
    let s = new BrowserSource();
    assertEqual(s.setState('firefox', 'example.com', ''), false);
    assertEqual(await s.resolve({}, 'brave-browser.desktop'), null);
});

test('browserSource: onChange fires only when state actually changes', () => {
    let s = new BrowserSource();
    let fired = [];
    s.onChange = b => fired.push(b);
    assertEqual(s.setState('brave', 'a.com', 'x'), true);
    assertEqual(s.setState('brave', 'a.com', 'x'), false);
    assertEqual(s.setState('brave', 'a.com', 'y'), true);
    assertEqual(s.clear('brave'), true);
    assertEqual(s.clear('brave'), false);
    assertEqual(fired, ['brave', 'brave', 'brave']);
});

test('browserSource: a detail named __other__ is renamed', async () => {
    let s = new BrowserSource();
    s.setState('zen', 'example.com', '__other__');
    assertEqual((await s.resolve({}, 'zen.desktop')).detailId, '_other_');
});

test('browserSource: destroy clears state and handler', async () => {
    let s = new BrowserSource();
    s.onChange = () => {};
    s.setState('brave', 'a.com', '');
    s.destroy();
    assertEqual(await s.resolve({}, 'brave-browser.desktop'), null);
    assertEqual(s.onChange, null);
});
