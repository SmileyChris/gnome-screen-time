import { test, assertEqual } from './harness.js';
import { reportFor, MAX_SEGMENT } from '../companion/webext/rules.js';

test('rules: host is lowercased and loses one leading www.', () => {
    assertEqual(reportFor('https://WWW.Example.com/', false), { host: 'example.com', detail: '' });
    assertEqual(reportFor('https://www.www.example.com/', false).host, 'www.example.com');
});

test('rules: other subdomains stay', () => {
    assertEqual(reportFor('https://gist.github.com/x/y', false).host, 'gist.github.com');
});

test('rules: repo hosts take owner/repo', () => {
    assertEqual(reportFor('https://github.com/anthropics/claude-code/issues/12', false),
        { host: 'github.com', detail: 'anthropics/claude-code' });
    assertEqual(reportFor('https://gitlab.com/group/subgroup/project', false).detail, 'group/subgroup');
    assertEqual(reportFor('https://codeberg.org/dnkl/foot', false).detail, 'dnkl/foot');
    assertEqual(reportFor('https://bitbucket.org/team/repo/src', false).detail, 'team/repo');
});

test('rules: repo host with one segment yields that segment', () => {
    assertEqual(reportFor('https://github.com/anthropics', false).detail, 'anthropics');
    assertEqual(reportFor('https://github.com/', false).detail, '');
});

test('rules: reddit takes r/<sub>, else first segment', () => {
    assertEqual(reportFor('https://www.reddit.com/r/gnome/comments/abc', false),
        { host: 'reddit.com', detail: 'r/gnome' });
    assertEqual(reportFor('https://old.reddit.com/r/linux', false).detail, 'r/linux');
    assertEqual(reportFor('https://reddit.com/user/someone', false).detail, 'user');
    assertEqual(reportFor('https://reddit.com/r/', false).detail, 'r');
});

test('rules: everything else takes the first path segment', () => {
    assertEqual(reportFor('https://youtube.com/watch?v=abc#t=1', false), { host: 'youtube.com', detail: 'watch' });
    assertEqual(reportFor('https://example.com', false).detail, '');
    assertEqual(reportFor('https://example.com///docs//x', false).detail, 'docs');
});

test('rules: segments are URL-decoded and capped', () => {
    assertEqual(reportFor('https://example.com/caf%C3%A9%20bar', false).detail, 'café bar');
    let long = 'a'.repeat(100);
    assertEqual(reportFor(`https://example.com/${long}`, false).detail, 'a'.repeat(MAX_SEGMENT));
    assertEqual(reportFor('https://example.com/%E0%A4%A', false).detail, '%E0%A4%A', 'bad escape kept raw');
});

test('rules: query and fragment never reach the detail', () => {
    assertEqual(reportFor('https://example.com/?secret=1', false).detail, '');
    assertEqual(reportFor('https://example.com/#/route', false).detail, '');
});

test('rules: non-web schemes and unparsable urls are empty', () => {
    assertEqual(reportFor('about:blank', false), { host: '', detail: '' });
    assertEqual(reportFor('chrome://extensions/', false), { host: '', detail: '' });
    assertEqual(reportFor('file:///home/chris/x.html', false), { host: '', detail: '' });
    assertEqual(reportFor('not a url', false), { host: '', detail: '' });
    assertEqual(reportFor('', false), { host: '', detail: '' });
    assertEqual(reportFor(undefined, false), { host: '', detail: '' });
});

test('rules: private windows are empty regardless of url', () => {
    assertEqual(reportFor('https://github.com/a/b', true), { host: '', detail: '' });
});
