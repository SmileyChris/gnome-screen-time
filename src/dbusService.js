import Gio from 'gi://Gio';
import { BROWSERS, MAX_ID_LENGTH } from './browserSource.js';

const OBJECT_PATH = '/org/gnome/Shell/Extensions/ScreenTime';

const INTERFACE_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.ScreenTime">
    <method name="ReportActiveTab">
      <arg type="s" direction="in" name="browser"/>
      <arg type="s" direction="in" name="host"/>
      <arg type="s" direction="in" name="detail"/>
    </method>
    <method name="GetCompanions">
      <arg type="a(ssb)" direction="out" name="companions"/>
    </method>
  </interface>
</node>`;

// Session-bus entry point for the browser companion's native host. Each
// report is handed to the BrowserSource. The caller's unique bus name is
// watched; when it vanishes (browser closed, host exited) that browser's
// state is cleared so a stale site is never credited after the fact.
export class DbusService {
    constructor(browserSource) {
        this._source = browserSource;
        this._watches = new Map();   // `${sender}\0${browser}` -> { id, browser }
        this._impl = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this._impl.export(Gio.DBus.session, OBJECT_PATH);
    }

    // gjs routes a method named `<Method>Async` the raw parameters and the
    // invocation, which is how the sender's unique name is read.
    ReportActiveTabAsync(params, invocation) {
        let [browser, host, detail] = params;
        if (!BROWSERS.includes(browser)) {
            let name = String(browser).slice(0, MAX_ID_LENGTH);
            console.debug(`[ScreenTime] ignoring report for unknown browser ${name}`);
            invocation.return_value(null);
            return;
        }
        // Watch first: the bookkeeping must not depend on the credit
        // pipeline below succeeding. Answer next: the host calls this
        // synchronously, so a fault in the pipeline must not stall it.
        this._watch(invocation.get_sender(), browser);
        invocation.return_value(null);
        try {
            this._source.setState(browser, host, detail);
        } catch (e) {
            console.error(`[ScreenTime] report handling failed: ${e.message}`);
        }
    }

    // Read-only status for the preferences window: one tuple per known
    // browser with its current site (or empty) and whether a native host is
    // connected for it right now.
    GetCompanions() {
        return BROWSERS.map(browser => {
            let connected = [...this._watches.values()].some(w => w.browser === browser);
            let state = this._source?.getState(browser);
            return [browser, state?.host ?? '', connected];
        });
    }

    // One watch per sender and browser: a single connection reporting for
    // two browsers must clear both when it vanishes.
    _watch(sender, browser) {
        let key = `${sender}\0${browser}`;
        if (this._watches.has(key))
            return;
        // The entry is captured so the vanish callback can release its own
        // watch; leaving it would leak a watcher per browser run.
        let entry = { id: 0, browser };
        entry.id = Gio.bus_watch_name(
            Gio.BusType.SESSION, sender, Gio.BusNameWatcherFlags.NONE,
            null,
            () => {
                Gio.bus_unwatch_name(entry.id);
                this._watches.delete(key);
                this._source?.clear(browser);
            });
        this._watches.set(key, entry);
    }

    destroy() {
        for (let { id } of this._watches.values())
            Gio.bus_unwatch_name(id);
        this._watches.clear();
        this._impl?.unexport();
        this._impl = null;
        this._source = null;
    }
}
