// Reports the focused window's active tab to the native host. Computes the
// report here so the full URL never leaves the browser; see rules.js.
import { reportFor, EMPTY_REPORT } from './rules.js';
import { BROWSER } from './browser-id.js';

const api = globalThis.browser ?? globalThis.chrome;
const HOST_NAME = 'org.gnome.shell.extensions.screen_time';
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 300000;
// A port that dies sooner than this never really worked (host missing or
// crashing on start), so the retry backs off. One that lived longer failed
// for a fresh reason and retries from the minimum again.
const HEALTHY_PORT_MS = 10000;

let port = null;
let connectedAt = 0;
let lastSent = null;      // "host\0detail" of the last report that went out
let retryMs = RETRY_MIN_MS;
let retryTimer = null;

function backOff() {
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
}

function connect() {
    if (port)
        return true;
    let p;
    try {
        p = api.runtime.connectNative(HOST_NAME);
    } catch (e) {
        console.error(`[screen-time] connectNative failed: ${e.message}`);
        return false;
    }
    connectedAt = Date.now();
    p.onDisconnect.addListener(() => {
        // A port we already replaced must not null out its successor.
        if (port !== p)
            return;
        // Host missing, crashed, or the Shell side is gone. Resend the
        // current state once we reconnect.
        let err = api.runtime.lastError?.message ?? p.error?.message;
        if (err)
            console.error(`[screen-time] native port closed: ${err}`);
        port = null;
        lastSent = null;
        if (Date.now() - connectedAt < HEALTHY_PORT_MS)
            backOff();
        else
            retryMs = RETRY_MIN_MS;
        scheduleRetry();
    });
    port = p;
    return true;
}

function scheduleRetry() {
    if (retryTimer)
        return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        report();
    }, retryMs);
}

async function currentReport() {
    let win;
    try {
        win = await api.windows.getLastFocused({ populate: true });
    } catch (e) {
        console.error(`[screen-time] windows.getLastFocused failed: ${e.message}`);
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
        backOff();
        scheduleRetry();
        return;
    }
    let p = port;
    try {
        p.postMessage({ browser: BROWSER, host: r.host, detail: r.detail });
        lastSent = key;
    } catch (e) {
        console.error(`[screen-time] postMessage failed: ${e.message}`);
        // Recover first: on Gecko, disconnecting an already-dead port
        // throws, and that must not cost us the retry.
        port = null;
        lastSent = null;
        backOff();
        scheduleRetry();
        // Close the broken port so it cannot linger half-open. The
        // onDisconnect guard above keeps its teardown off a replacement.
        try {
            p.disconnect();
        } catch {
            // already gone
        }
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
