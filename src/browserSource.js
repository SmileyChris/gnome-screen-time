import { OTHER_KEY } from './usageStore.js';

// GNOME app ids claimed by the browser companion, mapped to the browser id
// the WebExtension puts in every report.
export const BROWSER_APP_IDS = {
    'brave-browser.desktop': 'brave',
    'zen.desktop': 'zen',
    'google-chrome.desktop': 'chrome',
    'firefox.desktop': 'firefox',
};
export const BROWSERS = Object.values(BROWSER_APP_IDS);

// The WebExtension already truncates path segments, but a report arrives
// over D-Bus from any session process, so cap the ids at the Shell
// boundary too: these become store keys and label text.
export const MAX_ID_LENGTH = 256;

// Activity source fed by the browser companion over D-Bus. Holds the last
// reported {host, detail} per browser and answers from that cache: nothing
// is spawned, polled or awaited. `onChange(browser)` fires when a browser's
// state actually changes so the tracker can re-credit immediately.
export class BrowserSource {
    constructor() {
        this._state = new Map();   // browser -> { host, detail, focused } | null
        this.onChange = null;
    }

    claims(appId) {
        return Object.hasOwn(BROWSER_APP_IDS, appId);
    }

    // Empty or null `host` means no breakdown. `focused` is the browser's own
    // window focus; the site is kept either way, for display, but only credited
    // while focused. Returns whether anything changed.
    setState(browser, host, detail, focused = true) {
        if (!BROWSERS.includes(browser))
            return false;
        let next = null;
        if (host) {
            let h = host.slice(0, MAX_ID_LENGTH);
            let d = detail ? detail.slice(0, MAX_ID_LENGTH) : null;
            // A host or path segment literally named "__other__" would merge
            // into the store's fold node for genuinely folded siblings.
            if (h === OTHER_KEY)
                h = '_other_';
            if (d === OTHER_KEY)
                d = '_other_';
            next = { host: h, detail: d, focused: focused === true };
        }
        let prev = this._state.get(browser) ?? null;
        if (prev?.host === next?.host && prev?.detail === next?.detail &&
            prev?.focused === next?.focused && (prev === null) === (next === null))
            return false;
        this._state.set(browser, next);
        this.onChange?.(browser);
        return true;
    }

    clear(browser) {
        return this.setState(browser, null, null);
    }

    // The last report for a browser as {host, detail, focused}, or null when it has
    // none (no breakdown, or never reported).
    getState(browser) {
        return this._state.get(browser) ?? null;
    }

    resolve(win, appId) {
        let browser = BROWSER_APP_IDS[appId];
        let s = browser ? this._state.get(browser) : null;
        if (!s || !s.focused)
            return Promise.resolve(null);
        return Promise.resolve({
            activityId: s.host, activityName: s.host,
            detailId: s.detail, detailName: s.detail,
        });
    }

    destroy() {
        this._state.clear();
        this.onChange = null;
    }
}
