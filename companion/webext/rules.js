// Turns the active tab's URL into the two ids the Shell extension stores:
// the site (host) and a site-specific unit (detail). Pure, no browser APIs,
// so it is unit tested under gjs alongside the extension's own modules.
// Nothing here ever reads the query string, fragment or title.

export const REPO_HOSTS = ['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org',
    'git.sr.ht', 'gitea.com'];
// Matched as a suffix, not an exact host: every language edition is its own
// subdomain (en.wikipedia.org, de.wikipedia.org), and the bare domain works too.
export const WIKI_DOMAINS = ['wikipedia.org', 'wiktionary.org', 'wikiquote.org'];
// Registries bury the package under one fixed container segment; the name
// after it is the unit worth recording.
export const REGISTRY_CONTAINERS = {
    'npmjs.com': 'package',
    'pypi.org': 'project',
    'crates.io': 'crates',
    'rubygems.org': 'gems',
};
// Jira is per-tenant (acme.atlassian.net), so it is a suffix match as well.
export const JIRA_DOMAIN = 'atlassian.net';
export const LINEAR_HOST = 'linear.app';
// A path segment longer than this is truncated so a pathological URL cannot
// become a huge storage key.
export const MAX_SEGMENT = 64;
export const EMPTY_REPORT = Object.freeze({ host: '', detail: '' });

function decodeSegment(segment) {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;   // malformed escape: keep it raw rather than drop it
    }
}

function segmentsOf(url) {
    return url.pathname.split('/')
        .filter(s => s.length > 0)
        .map(s => decodeSegment(s).slice(0, MAX_SEGMENT));
}

// A date or id component in front of the real unit (/2026/09/21/<section>).
const NUMERIC_SEGMENT = /^\d+$/;
// A segment this short is a routing prefix, not a unit: /r/<sub>, /c/<channel>,
// /us/<section>, /dp/<product>. It is reported with the segment it routes to.
const MAX_PREFIX = 2;
// The most segments a default detail joins. A date is three, and the cap
// keeps an all-numeric or prefix-stacked path from becoming a long key.
const MAX_DETAIL_SEGMENTS = 3;
// Languages sites actually put first in a path. Recognising one lets its
// regional forms share a row (fr-FR and fr both report fr) and lets the rule
// carry on past it. Deliberately short of full ISO 639-1: id, is, no, ms and
// the like are far more often ordinary path words (/id/123), and as plain
// prefixes they keep the id that follows them.
const LOCALE_LANGUAGES = new Set([
    'ar', 'bg', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi',
    'fr', 'he', 'hi', 'hr', 'hu', 'it', 'ja', 'ko', 'lt', 'lv', 'nb', 'nl',
    'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sr', 'sv', 'th', 'tr', 'uk', 'vi',
    'zh',
]);
// The optional part after the language: a country (en-US), a script
// (zh-Hans) or a UN M.49 region (es-419).
const LOCALE_REGION = /^([a-z]{2}|[a-z]{4}|\d{3})$/;

// The language of a locale segment, or null if the segment is not one.
function localeLanguage(segment) {
    let [language, region, ...rest] = segment.toLowerCase().split(/[-_]/);
    if (rest.length > 0 || !LOCALE_LANGUAGES.has(language))
        return null;
    if (region !== undefined && !LOCALE_REGION.test(region))
        return null;
    return language;
}

// Leading dates are skipped, unless the path is nothing but dates, which then
// is the unit: "21" alone would merge every month and year into one row. A
// locale is kept as its language and the rule carries on after it, so
// /en/t/<topic> keeps the topic. Any other prefix takes exactly one segment:
// /r/nz/comments must be the same row as /r/nz.
function defaultParts(segs) {
    let i = 0;
    while (i < segs.length && NUMERIC_SEGMENT.test(segs[i]))
        i++;
    if (i === segs.length)
        return segs.slice(0, MAX_DETAIL_SEGMENTS);
    let language = localeLanguage(segs[i]);
    if (language)
        return [language, ...defaultParts(segs.slice(i + 1))];
    if (segs[i].length <= MAX_PREFIX && i + 1 < segs.length)
        return [segs[i], segs[i + 1]];
    return [segs[i]];
}

function defaultDetail(segs) {
    return defaultParts(segs).slice(0, MAX_DETAIL_SEGMENTS).join('/');
}

function inDomain(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
}

// An issue id carries its project or team in front of the number
// (SCREEN-12 -> SCREEN); an id without one is already the key.
function keyOf(issueId) {
    return issueId.split('-')[0];
}

// The site unit, or '' when the path gives nothing. Every branch falls
// through to defaultDetail(), so an unrecognised path on a known host still
// reports something rather than going blank. The host rules run
// first and take their segments raw: a two-letter repo owner or an article
// named for a year must not be mistaken for a locale or a date.
function detailFor(host, segs) {
    if (REPO_HOSTS.includes(host))
        return segs.slice(0, 2).join('/');
    if (WIKI_DOMAINS.some(d => inDomain(host, d)) && segs[0] === 'wiki' && segs[1])
        return segs[1];
    let container = REGISTRY_CONTAINERS[host];
    if (container && segs[0] === container && segs[1]) {
        // A scoped npm package is two segments: @babel/core, not @babel.
        if (segs[1].startsWith('@') && segs[2])
            return `${segs[1]}/${segs[2]}`;
        return segs[1];
    }
    if (inDomain(host, JIRA_DOMAIN)) {
        if (segs[0] === 'browse' && segs[1])
            return keyOf(segs[1]);
        // Board and backlog urls read /jira/<product>/projects/<KEY>/...
        let i = segs.indexOf('projects');
        if (i >= 0 && segs[i + 1])
            return segs[i + 1];
    }
    if (host === LINEAR_HOST && segs[1] === 'issue' && segs[2])
        return keyOf(segs[2]);
    return defaultDetail(segs);
}

export function reportFor(urlString, incognito) {
    if (incognito || typeof urlString !== 'string')
        return EMPTY_REPORT;
    let url;
    try {
        url = new URL(urlString);
    } catch (e) {
        // Browsers throw TypeError for an unparsable URL. Anything else means
        // the environment has no URL parser at all, which must not read as
        // "no breakdown": let it surface.
        if (e instanceof TypeError)
            return EMPTY_REPORT;
        throw e;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return EMPTY_REPORT;

    let host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!host)
        return EMPTY_REPORT;

    return { host, detail: detailFor(host, segmentsOf(url)) };
}
