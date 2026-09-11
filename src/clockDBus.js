import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { evidenceFor } from './evidence.js';
import { readClients } from './clients.js';
import { mergeSessions, selectExportable, countSkippedUnknown, toJSON, toCSV } from './timeExport.js';

const OBJECT_PATH = '/org/gnome/Shell/Extensions/ScreenTime/Clock';

// ExportPeriod's day keys arrive as plain strings from another process.
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// GetEvidence's session can have any span at all - a hand-edited or
// mis-typed startMs (the year 2000 is a valid timestamp - see
// clockStore.js's MIN_TIMESTAMP_MS) against an endMs near now walks
// IntervalLog.query()'s day-by-day loop across every day in between: a
// session moved back to 2000 walks roughly 36,500 day keys, a measured
// ~0.5s stall in the compositor's own thread for one D-Bus call. Refused
// well before that gets anywhere close.
const MAX_EVIDENCE_SPAN_DAYS = 400;
const MAX_EVIDENCE_SPAN_MS = MAX_EVIDENCE_SPAN_DAYS * 24 * 3600 * 1000;

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
    <method name="ExportPeriod">
      <arg type="s" direction="in" name="fromDayKey"/>
      <arg type="s" direction="in" name="toDayKeyExclusive"/>
      <arg type="s" direction="in" name="path"/>
      <arg type="s" direction="in" name="format"/>
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
        // See MAX_EVIDENCE_SPAN_MS above: refused before it ever reaches
        // IntervalLog.query(), which is what actually walks a day per key
        // in range.
        let span = (session.endMs ?? Date.now()) - session.startMs;
        if (span > MAX_EVIDENCE_SPAN_MS)
            return JSON.stringify({ error: 'span' });
        // Buffered intervals have not reached disk, and query() reads
        // files, so flush the tail first. The window must never see less
        // evidence than the Shell already holds.
        this._intervals.flushAll();
        return JSON.stringify(evidenceFor(session, this._intervals));
    }

    // Whether the store's most recent save attempt actually reached disk -
    // see ClockStore.readOnly/saveFailing. Every mutating reply below
    // includes this as `saved`, so a caller that only checked `error` (a
    // rejected call) can also tell a call that succeeded in memory but
    // never reached clock.json - the D-Bus reply would otherwise report
    // bare success with nothing to say the change is one restart away from
    // being lost.
    _saved() {
        return !this._clock.readOnly && !this._clock.saveFailing;
    }

    StartSession(client) {
        try {
            let session = this._clock.start(client);
            return JSON.stringify({ ...session, saved: this._saved() });
        } catch (e) {
            return JSON.stringify({ error: e.message });
        }
    }

    StopSession() {
        try {
            let session = this._clock.stop();
            return JSON.stringify(session ? { ...session, saved: this._saved() } : null);
        } catch (e) {
            return JSON.stringify({ error: e.message });
        }
    }

    UpdateSession(sessionId, fields) {
        try {
            let updated = this._clock.update(sessionId, JSON.parse(fields));
            if (!updated)
                return JSON.stringify({ error: 'missing' });
            return JSON.stringify({ ...updated, saved: this._saved() });
        } catch (e) {
            return JSON.stringify({ error: e.message });
        }
    }

    DeleteSession(sessionId) {
        return JSON.stringify({ removed: this._clock.remove(sessionId), saved: this._saved() });
    }

    // fromDayKey/toDayKeyExclusive select whole calendar days (see
    // ClockStore.sessionsForDays()), not an overlapping time span, so a
    // session that starts late on the last day of a month never spills into
    // the next month's export. Both come from another process - the window
    // computes them from local calendar dates, but nothing stops a hand-
    // crafted call - so they are validated here before being trusted as
    // strings for comparison.
    //
    // Re-emits the whole period every time. Identity is a row's
    // external_id, so a corrected session updates its row on the receiving
    // side rather than adding a second one; exportedAt is only a display
    // hint in the Timesheet and never filters anything out of a later
    // export.
    //
    // `recorded` in the result is false when the store could not persist
    // the exportedAt stamps to disk (ClockStore.readOnly or saveFailing -
    // see _saved() above and there): the export file itself was still
    // written successfully, but a Shell restart would forget which
    // sessions were just exported, so the window needs to say so rather
    // than report plain success.
    ExportPeriod(fromDayKey, toDayKeyExclusive, path, format) {
        try {
            if (!DAY_KEY_RE.test(fromDayKey) || !DAY_KEY_RE.test(toDayKeyExclusive) ||
                !(fromDayKey < toDayKeyExclusive))
                return JSON.stringify({ error: 'invalid' });
            // The Timesheet always builds an absolute path from Gtk.FileDialog,
            // but nothing stops a hand-crafted call from sending a relative
            // one, which Gio.File.new_for_path() would resolve against this
            // process's own cwd (the Shell's, not the caller's) - writing
            // somewhere the caller never chose and never saw.
            if (!GLib.path_is_absolute(path))
                return JSON.stringify({ error: 'invalid' });

            let sessions = this._clock.sessionsForDays(fromDayKey, toDayKeyExclusive);
            let clients = readClients(this._settings);
            let rows = mergeSessions(sessions, clients);
            let text = format === 'csv' ? toCSV(rows) : toJSON(rows);
            Gio.File.new_for_path(path).replace_contents(
                new TextEncoder().encode(text),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

            // Only the sessions that actually produced a row: mergeSessions
            // also excludes a non-billable or unknown client and a
            // negative-duration record, and markExported() must not stamp
            // exportedAt on a session that never appeared in the file.
            let exportable = selectExportable(sessions, clients);
            this._clock.markExported(exportable.map(s => s.id));
            // Closed sessions skipped specifically because their client
            // isn't on the list at all (deleted from Preferences, most
            // likely) - not the non-billable ones selectExportable() also
            // drops, which are a deliberate exclusion, not something to
            // flag. The window mentions this when it's non-zero.
            let skippedUnknown = countSkippedUnknown(sessions, clients);
            return JSON.stringify({
                rows: rows.length, recorded: this._saved(), skippedUnknown,
            });
        } catch (e) {
            return JSON.stringify({ error: e.message });
        }
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
