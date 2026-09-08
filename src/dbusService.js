import Gio from 'gi://Gio';

const OBJECT_PATH = '/org/gnome/Shell/Extensions/ScreenTime';

const INTERFACE_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.ScreenTime">
    <method name="ReportActiveTab">
      <arg type="s" direction="in" name="browser"/>
      <arg type="s" direction="in" name="host"/>
      <arg type="s" direction="in" name="detail"/>
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
        this._watches = new Map();   // sender unique name -> { id, browser }
        this._impl = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this._impl.export(Gio.DBus.session, OBJECT_PATH);
    }

    // gjs routes a method named `<Method>Async` the invocation, which is how
    // the sender's unique name is read.
    ReportActiveTabAsync(params, invocation) {
        let [browser, host, detail] = params;
        // Watch first: the bookkeeping must not depend on the credit
        // pipeline below succeeding.
        this._watch(invocation.get_sender(), browser);
        this._source.setState(browser, host, detail);
        invocation.return_value(null);
    }

    _watch(sender, browser) {
        if (this._watches.has(sender))
            return;
        let id = Gio.bus_watch_name(
            Gio.BusType.SESSION, sender, Gio.BusNameWatcherFlags.NONE,
            null,
            () => {
                this._watches.delete(sender);
                this._source?.clear(browser);
            });
        this._watches.set(sender, { id, browser });
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
