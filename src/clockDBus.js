import Gio from 'gi://Gio';
import { evidenceFor } from './evidence.js';
import { readClients } from './clients.js';

const OBJECT_PATH = '/org/gnome/Shell/Extensions/ScreenTime/Clock';

// Payloads cross as JSON rather than as nested variants: the shapes here grow
// with the feature, and a hand-maintained D-Bus signature on both sides of a
// process boundary is a standing bug.
//
// Exported so the Timesheet window (timesheetWindow.js), a separate process,
// builds its proxy from this same string instead of a pasted second copy -
// a method added here then exists on both sides by construction.
export const INTERFACE_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.ScreenTime.Clock">
    <method name="GetClients">
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="GetSessions">
      <arg type="x" direction="in" name="fromMs"/>
      <arg type="x" direction="in" name="toMs"/>
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="GetEvidence">
      <arg type="s" direction="in" name="sessionId"/>
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="StartSession">
      <arg type="s" direction="in" name="client"/>
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="StopSession">
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="UpdateSession">
      <arg type="s" direction="in" name="sessionId"/>
      <arg type="s" direction="in" name="fields"/>
      <arg type="s" direction="out" name="json"/>
    </method>
    <method name="DeleteSession">
      <arg type="s" direction="in" name="sessionId"/>
      <arg type="s" direction="out" name="json"/>
    </method>
    <signal name="ClockChanged"/>
  </interface>
</node>`;

// Session-bus entry point for the Timesheet window. The window is a pure
// D-Bus client: UsageStore._load() runs once from the constructor and
// _save() writes the whole in-memory object, so a second writer to those
// files would be silently clobbered on the next tick, and a disk read would
// miss the open session and whatever IntervalLog is still holding buffered.
// Serving everything from the Shell's own memory avoids both.
//
// Errors come back as `{ "error": "..." }` in the JSON rather than as D-Bus
// exceptions, so the window has exactly one failure path to handle.
export class ClockDBus {
    constructor(clock, intervalLog, settings) {
        this._clock = clock;
        this._intervals = intervalLog;
        this._settings = settings;
        this._impl = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this._impl.export(Gio.DBus.session, OBJECT_PATH);
        // Captures whatever handler is already on clock.onChange and chains
        // through it. Anything else that wants to observe the clock must
        // set clock.onChange BEFORE this constructor runs: an assignment
        // after this point replaces this wrapper outright, and ClockChanged
        // would silently stop firing - no error, no signal, nothing.
        this._prevOnChange = clock.onChange;
        clock.onChange = () => {
            this._prevOnChange?.();
            this._impl?.emit_signal('ClockChanged', null);
        };
    }

    GetClients() {
        return JSON.stringify(readClients(this._settings));
    }

    GetSessions(fromMs, toMs) {
        return JSON.stringify(this._clock.sessionsInRange(fromMs, toMs));
    }

    GetEvidence(sessionId) {
        let session = this._clock.sessionById(sessionId);
        if (!session)
            return JSON.stringify({ error: 'missing' });
        // Buffered intervals have not reached disk, and query() reads
        // files, so flush the tail first. The window must never see less
        // evidence than the Shell already holds.
        this._intervals.flushAll();
        return JSON.stringify(evidenceFor(session, this._intervals));
    }

    StartSession(client) {
        try {
            return JSON.stringify(this._clock.start(client));
        } catch (e) {
            return JSON.stringify({ error: e.message });
        }
    }

    StopSession() {
        return JSON.stringify(this._clock.stop());
    }

    UpdateSession(sessionId, fields) {
        try {
            let updated = this._clock.update(sessionId, JSON.parse(fields));
            return JSON.stringify(updated ?? { error: 'missing' });
        } catch (e) {
            return JSON.stringify({ error: e.message });
        }
    }

    DeleteSession(sessionId) {
        return JSON.stringify({ removed: this._clock.remove(sessionId) });
    }

    destroy() {
        if (this._clock)
            this._clock.onChange = this._prevOnChange ?? null;
        this._impl?.unexport();
        this._impl = null;
        this._clock = null;
        this._intervals = null;
        this._settings = null;
    }
}
