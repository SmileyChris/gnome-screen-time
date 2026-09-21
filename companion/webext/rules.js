// Turns the active tab's URL into the two ids the Shell extension stores:
// the site (host) and a site-specific unit (detail). Pure, no browser APIs,
// so it is unit tested under gjs alongside the extension's own modules.
// Nothing here ever reads the query string, fragment or title.

export const REPO_HOSTS = ['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org',
    'git.sr.ht', 'gitea.com'];
export const REDDIT_HOSTS = ['reddit.com', 'old.reddit.com'];
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

// Segments that are never the unit anyone means: a date or id component, and
// a documentation site's locale prefix. Only stripped from the front of a
// path, and only where no host rule applies.
const NUMERIC_SEGMENT = /^\d+$/;
const LOCALE_SEGMENT = /^[a-z]{2}(-[a-z]{2,4})?$/i;

function skippable(segment) {
    return NUMERIC_SEGMENT.test(segment) || LOCALE_SEGMENT.test(segment);
}

// The first segment worth recording. The last segment is never skipped, so a
// path that is nothing but dates still reports its deepest part rather than
// collapsing to the bare host.
function firstMeaningful(segs) {
    let i = 0;
    while (i < segs.length - 1 && skippable(segs[i]))
        i++;
    return segs[i] ?? '';
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
// through to the first meaningful segment, so an unrecognised path on a known
// host still reports something rather than going blank. The host rules run
// first and take their segments raw: a two-letter repo owner or an article
// named for a year must not be mistaken for a locale or a date.
function detailFor(host, segs) {
    if (REPO_HOSTS.includes(host))
        return segs.slice(0, 2).join('/');
    if (REDDIT_HOSTS.includes(host) && segs[0] === 'r' && segs[1])
        return `r/${segs[1]}`;
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
    return firstMeaningful(segs);
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
