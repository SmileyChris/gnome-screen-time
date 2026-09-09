import { test, assert, assertEqual } from './harness.js';
import { BrowserSource, BROWSERS, MAX_ID_LENGTH } from '../src/browserSource.js';

test('browserSource: claims exactly the two browser app ids', () => {
    let s = new BrowserSource();
    assert(s.claims('brave-browser.desktop'));
    assert(s.claims('zen.desktop'));
    assert(!s.claims('firefox.desktop'));
    assert(!s.claims('org.gnome.Console.desktop'));
    assertEqual(BROWSERS, ['brave', 'zen', 'chrome', 'firefox']);
    assert(s.claims('google-chrome.desktop'));
    assert(s.claims('firefox.desktop'));
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

test('browserSource: a host named __other__ is renamed too', async () => {
    let s = new BrowserSource();
    s.setState('brave', '__other__', 'x');
    assertEqual((await s.resolve({}, 'brave-browser.desktop')).activityId, '_other_');
});

test('browserSource: an overlong host is capped', async () => {
    let s = new BrowserSource();
    s.setState('brave', 'a'.repeat(1000), 'b'.repeat(1000));
    let sub = await s.resolve({}, 'brave-browser.desktop');
    assertEqual(sub.activityId.length, MAX_ID_LENGTH);
    assertEqual(sub.detailId.length, MAX_ID_LENGTH);
});

test('browserSource: claims ignores inherited property names', () => {
    let s = new BrowserSource();
    assert(!s.claims('toString'));
    assert(!s.claims('constructor'));
});

test('browserSource: getState mirrors the last report per browser', () => {
    let s = new BrowserSource();
    assertEqual(s.getState('brave'), null);
    s.setState('brave', 'github.com', 'a/b');
    assertEqual(s.getState('brave'), { host: 'github.com', detail: 'a/b', focused: true });
    s.setState('brave', '', '');
    assertEqual(s.getState('brave'), null);
    assertEqual(s.getState('nope'), null);
});

test('browserSource: an unfocused report is kept for display but not credited', async () => {
    let s = new BrowserSource();
    let fired = 0;
    s.onChange = () => fired++;
    s.setState('chrome', 'docs.example.com', 'guide', false);
    assertEqual(s.getState('chrome'), { host: 'docs.example.com', detail: 'guide', focused: false });
    assertEqual(await s.resolve({}, 'google-chrome.desktop'), null);
    assertEqual(s.setState('chrome', 'docs.example.com', 'guide', true), true, 'focus change is a change');
    assertEqual((await s.resolve({}, 'google-chrome.desktop')).activityId, 'docs.example.com');
    assertEqual(fired, 2);
});
