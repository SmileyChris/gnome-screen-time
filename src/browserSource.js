import { OTHER_KEY } from './usageStore.js';

// GNOME app ids claimed by the browser companion, mapped to the browser id
// the WebExtension puts in every report.
export const BROWSER_APP_IDS = {
    'brave-browser.desktop': 'brave',
    'zen.desktop': 'zen',
};
export const BROWSERS = Object.values(BROWSER_APP_IDS);

// Activity source fed by the browser companion over D-Bus. Holds the last
// reported {host, detail} per browser and answers from that cache: nothing
// is spawned, polled or awaited. `onChange(browser)` fires when a browser's
// state actually changes so the tracker can re-credit immediately.
export class BrowserSource {
    constructor() {
        this._state = new Map();   // browser -> { host, detail } | null
        this.onChange = null;
    }

    claims(appId) {
        return appId in BROWSER_APP_IDS;
    }

    // Empty or null `host` means no breakdown. Returns whether anything changed.
    setState(browser, host, detail) {
        if (!BROWSERS.includes(browser))
            return false;
        let next = null;
        if (host) {
            // A path segment literally named "__other__" would merge into the
            // store's fold node for genuinely folded siblings.
            let d = detail || null;
            if (d === OTHER_KEY)
                d = '_other_';
            next = { host, detail: d };
        }
        let prev = this._state.get(browser) ?? null;
        if (prev?.host === next?.host && prev?.detail === next?.detail && (prev === null) === (next === null))
            return false;
        this._state.set(browser, next);
        this.onChange?.(browser);
        return true;
    }

    clear(browser) {
        return this.setState(browser, null, null);
    }

    resolve(win, appId) {
        let browser = BROWSER_APP_IDS[appId];
        let s = browser ? this._state.get(browser) : null;
        if (!s)
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
