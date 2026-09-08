// Reports the focused window's active tab to the native host. Computes the
// report here so the full URL never leaves the browser; see rules.js.
import { reportFor, EMPTY_REPORT } from './rules.js';
import { BROWSER } from './browser-id.js';

const api = globalThis.browser ?? globalThis.chrome;
const HOST_NAME = 'org.gnome.shell.extensions.screen_time';
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 300000;

let port = null;
let lastSent = null;      // "host\0detail" of the last report that went out
let retryMs = RETRY_MIN_MS;
let retryTimer = null;

function connect() {
    if (port)
        return true;
    let p;
    try {
        p = api.runtime.connectNative(HOST_NAME);
    } catch (e) {
        return false;
    }
    p.onDisconnect.addListener(() => {
        // Host missing, crashed, or the Shell side is gone. Resend the
        // current state once we reconnect, with backoff while it keeps failing.
        port = null;
        lastSent = null;
        scheduleRetry();
    });
    port = p;
    lastSent = null;
    return true;
}

function scheduleRetry() {
    if (retryTimer)
        return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
        report();
    }, retryMs);
}

async function currentReport() {
    let win;
    try {
        win = await api.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
    } catch (e) {
        return EMPTY_REPORT;
    }
    if (!win || !win.focused)
        return EMPTY_REPORT;   // the browser itself is not the focused app
    let tab = win.tabs?.find(t => t.active);
    if (!tab || !tab.url)
        return EMPTY_REPORT;
    return reportFor(tab.url, win.incognito === true);
}

async function report() {
    let r = await currentReport();
    let key = `${r.host}\0${r.detail}`;
    if (key === lastSent)
        return;
    if (!connect()) {
        scheduleRetry();
        return;
    }
    try {
        port.postMessage({ browser: BROWSER, host: r.host, detail: r.detail });
        lastSent = key;
        retryMs = RETRY_MIN_MS;
    } catch (e) {
        port = null;
        lastSent = null;
        scheduleRetry();
    }
}

api.tabs.onActivated.addListener(() => report());
api.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url)
        report();
});
api.windows.onFocusChanged.addListener(() => report());
api.runtime.onStartup?.addListener(() => report());
report();
