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
    assertEqual(reportFor('https://reddit.com/r/de', false).detail, 'r/de', 'locale-shaped sub kept');
    assertEqual(reportFor('https://new.reddit.com/r/gnome', false).detail, 'r/gnome');
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

test('rules: wiki hosts take the article, any language subdomain', () => {
    assertEqual(reportFor('https://en.wikipedia.org/wiki/GNOME', false),
        { host: 'en.wikipedia.org', detail: 'GNOME' });
    assertEqual(reportFor('https://de.wikipedia.org/wiki/Wayland_(Protokoll)', false).detail,
        'Wayland_(Protokoll)');
    assertEqual(reportFor('https://wikipedia.org/wiki/Bare', false).detail, 'Bare');
    assertEqual(reportFor('https://en.wiktionary.org/wiki/dog', false).detail, 'dog');
    assertEqual(reportFor('https://en.wikiquote.org/wiki/Ada_Lovelace', false).detail, 'Ada_Lovelace');
});

test('rules: a wiki host off the article path falls back to the default rule', () => {
    assertEqual(reportFor('https://en.wikipedia.org/w/index.php', false).detail, 'w/index.php');
    assertEqual(reportFor('https://en.wikipedia.org/wiki/', false).detail, 'wiki');
    assertEqual(reportFor('https://en.wikipedia.org/', false).detail, '');
});

test('rules: a lookalike wiki host is not treated as wikipedia', () => {
    assertEqual(reportFor('https://notwikipedia.org/wiki/X', false).detail, 'wiki');
});

test('rules: sourcehut and gitea take owner/repo', () => {
    assertEqual(reportFor('https://git.sr.ht/~sircmpwn/hare/tree/master', false).detail, '~sircmpwn/hare');
    assertEqual(reportFor('https://gitea.com/gitea/tea', false).detail, 'gitea/tea');
});

test('rules: package registries take the package name', () => {
    assertEqual(reportFor('https://www.npmjs.com/package/rxjs', false),
        { host: 'npmjs.com', detail: 'rxjs' });
    assertEqual(reportFor('https://pypi.org/project/requests/', false).detail, 'requests');
    assertEqual(reportFor('https://crates.io/crates/serde/1.0.0', false).detail, 'serde');
    assertEqual(reportFor('https://rubygems.org/gems/rails', false).detail, 'rails');
});

test('rules: a scoped npm package keeps its scope', () => {
    assertEqual(reportFor('https://npmjs.com/package/@babel/core', false).detail, '@babel/core');
});

test('rules: a registry host off the package path falls back to the first segment', () => {
    assertEqual(reportFor('https://npmjs.com/settings/chris/packages', false).detail, 'settings');
    assertEqual(reportFor('https://npmjs.com/package/', false).detail, 'package');
});

test('rules: jira takes the project key from a browse url', () => {
    assertEqual(reportFor('https://acme.atlassian.net/browse/SCREEN-12', false),
        { host: 'acme.atlassian.net', detail: 'SCREEN' });
    assertEqual(reportFor('https://acme.atlassian.net/browse/OPS-4?filter=1', false).detail, 'OPS');
    assertEqual(reportFor('https://acme.atlassian.net/browse/NOTAKEY', false).detail, 'NOTAKEY');
});

test('rules: jira takes the project key from a projects url', () => {
    assertEqual(reportFor('https://acme.atlassian.net/jira/software/projects/OPS/boards/3', false).detail, 'OPS');
    assertEqual(reportFor('https://acme.atlassian.net/jira/core/projects/BIZ/summary', false).detail, 'BIZ');
});

test('rules: jira elsewhere falls back to the first segment', () => {
    assertEqual(reportFor('https://acme.atlassian.net/jira/your-work', false).detail, 'jira');
    assertEqual(reportFor('https://acme.atlassian.net/', false).detail, '');
});

test('rules: linear takes the team prefix of an issue', () => {
    assertEqual(reportFor('https://linear.app/acme/issue/ENG-123/some-title', false),
        { host: 'linear.app', detail: 'ENG' });
    assertEqual(reportFor('https://linear.app/acme/issue/ENG-123', false).detail, 'ENG');
});

test('rules: linear off an issue falls back to the workspace', () => {
    assertEqual(reportFor('https://linear.app/acme/inbox', false).detail, 'acme');
    assertEqual(reportFor('https://linear.app/acme/issue/', false).detail, 'acme');
});

test('rules: a leading run of date segments is skipped', () => {
    assertEqual(reportFor('https://www.nytimes.com/2026/09/21/technology/gnome-thing.html', false),
        { host: 'nytimes.com', detail: 'technology' });
    assertEqual(reportFor('https://example.com/2026/09/a-post', false).detail, 'a-post');
});

test('rules: a leading locale segment is skipped', () => {
    assertEqual(reportFor('https://developer.mozilla.org/en-US/docs/Web/API/fetch', false),
        { host: 'developer.mozilla.org', detail: 'docs' });
    assertEqual(reportFor('https://developer.mozilla.org/ja/docs/Web', false).detail, 'docs');
    assertEqual(reportFor('https://example.com/pt-BR/help/x', false).detail, 'help');
});

test('rules: a path of nothing but skippable segments reports them whole', () => {
    assertEqual(reportFor('https://example.com/2026/09/21', false).detail, '2026/09/21');
    assertEqual(reportFor('https://example.com/2026/09', false).detail, '2026/09');
    assertEqual(reportFor('https://example.com/2026', false).detail, '2026');
    assertEqual(reportFor('https://example.com/en-US', false).detail, 'en-US');
    assertEqual(reportFor('https://example.com/en-US/2026', false).detail, 'en-US/2026');
});

test('rules: a wholly skippable path is capped so it cannot become a huge key', () => {
    assertEqual(reportFor('https://example.com/1/2/3/4/5/6', false).detail, '1/2/3');
});

test('rules: skipping does not apply to hosts with their own rule', () => {
    assertEqual(reportFor('https://github.com/de/repo', false).detail, 'de/repo');
    assertEqual(reportFor('https://en.wikipedia.org/wiki/2026', false).detail, '2026');
    assertEqual(reportFor('https://npmjs.com/package/left-pad', false).detail, 'left-pad');
    assertEqual(reportFor('https://reddit.com/r/gnome', false).detail, 'r/gnome');
});

test('rules: a single-character prefix takes the next segment with it', () => {
    assertEqual(reportFor('https://youtube.com/c/Veritasium/videos', false),
        { host: 'youtube.com', detail: 'c/Veritasium' });
    assertEqual(reportFor('https://forum.example.com/t/some-topic-slug/9912', false).detail,
        't/some-topic-slug');
    assertEqual(reportFor('https://x.com/i/lists/12345', false).detail, 'i/lists');
    assertEqual(reportFor('https://reddit.com/u/someone', false).detail, 'u/someone');
});

test('rules: a single-character prefix with nothing after it stands alone', () => {
    assertEqual(reportFor('https://example.com/c', false).detail, 'c');
});

test('rules: a single-character prefix after a skipped locale still extends', () => {
    assertEqual(reportFor('https://example.com/en/t/topic', false).detail, 't/topic');
});
