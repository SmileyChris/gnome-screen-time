// Turns the active tab's URL into the two ids the Shell extension stores:
// the site (host) and a site-specific unit (detail). Pure, no browser APIs,
// so it is unit tested under gjs alongside the extension's own modules.
// Nothing here ever reads the query string, fragment or title.

export const REPO_HOSTS = ['github.com', 'gitlab.com', 'codeberg.org', 'bitbucket.org'];
export const REDDIT_HOSTS = ['reddit.com', 'old.reddit.com'];
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

export function reportFor(urlString, incognito) {
    if (incognito || typeof urlString !== 'string')
        return EMPTY_REPORT;
    let url;
    try {
        url = new URL(urlString);
    } catch {
        return EMPTY_REPORT;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return EMPTY_REPORT;

    let host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!host)
        return EMPTY_REPORT;

    let segs = segmentsOf(url);
    let detail;
    if (REPO_HOSTS.includes(host))
        detail = segs.slice(0, 2).join('/');
    else if (REDDIT_HOSTS.includes(host) && segs[0] === 'r' && segs[1])
        detail = `r/${segs[1]}`;
    else
        detail = segs[0] ?? '';
    return { host, detail };
}
