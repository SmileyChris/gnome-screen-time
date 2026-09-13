import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Pango from 'gi://Pango';

// The Timesheet is a separate process from the Shell, so its D-Bus proxy is
// built from the same XML the Shell exports rather than a pasted second
// copy: a method added to ClockDBus then exists on both sides by
// construction, instead of silently drifting out of sync here.
import { INTERFACE_XML } from './clockDBus.js';
// parseClock lives in its own portable module (GLib only, no Adw/Gtk) so it
// can be unit-tested directly rather than only ever exercised through this
// GTK-dependent window.
import { parseClock } from './clockTime.js';
import { HoursBinding, saveFields } from './timesheetDraft.js';

const ClockProxy = Gio.DBusProxy.makeProxyWrapper(INTERFACE_XML);

// The Bill row's heading. One helper, since _tickLive() rewrites it while a
// session runs.
function billHeading(hours) {
    return `Bill · ${hours.toFixed(2)} h on the clock`;
}

// One compact line of the Activities block: name on the left, hours on the
// right, indented and dimmed below the app it belongs to.
function activityLine(name, seconds, depth) {
    let line = new Gtk.Box({ spacing: 12, margin_start: depth * 16 });
    line.append(new Gtk.Label({
        label: name,
        xalign: 0,
        hexpand: true,
        ellipsize: Pango.EllipsizeMode.END,
        css_classes: ['caption'],
    }));
    line.append(new Gtk.Label({
        label: formatHours(seconds / 3600),
        css_classes: ['caption', 'numeric'],
    }));
    if (depth > 0)
        line.add_css_class('dim-label');
    return line;
}

// billedHours may be legitimately 0, so this must never be a truthiness
// check - a deliberately zeroed session would otherwise display its actual
// hours instead. One helper so every caller (more arrive in later tasks)
// gets this right by construction.
function hasBilledHours(session) {
    return session.billedHours !== null && session.billedHours !== undefined;
}

// Whether keyboard focus is on widget or anything inside it. A SpinButton's
// focus sits on its internal text entry, so has_focus alone would miss it.
function hasFocusWithin(widget) {
    let focus = widget.get_root()?.get_focus() ?? null;
    return focus !== null && (focus === widget || focus.is_ancestor(widget));
}

function hoursOf(session) {
    if (hasBilledHours(session))
        return session.billedHours;
    return ((session.endMs ?? Date.now()) - session.startMs) / 3600000;
}

function actualHoursOf(session) {
    return ((session.endMs ?? Date.now()) - session.startMs) / 3600000;
}

// A session's contribution in whole milliseconds - mirrors timeExport.js's
// sessionMs(), for the same reason: summing hoursOf() as a float per
// session and adding those floats together can round to a different total
// than summing whole milliseconds and rounding once, since hours cannot
// exactly represent most decimal fractions. Used only for the per-day total
// below, so this window's own figure never quietly disagrees with what
// actually gets exported for the same day.
function sessionMs(session) {
    if (hasBilledHours(session))
        return Math.round(session.billedHours * 3600000);
    return (session.endMs ?? Date.now()) - session.startMs;
}

function clockOf(ms) {
    return GLib.DateTime.new_from_unix_local(ms / 1000).format('%H:%M');
}

// How often _tickLive() (see there) recomputes a running session's figures
// locally. Independent of the clock's own 30s heartbeat in the Shell - that
// one never fires ClockChanged (see the comments on _timeRow and
// _draftFor), so it cannot be relied on to keep anything in this window
// current.
const LIVE_TICK_SECONDS = 30;

// The subtitle text for a session row: its start-end clock times, its
// hours, and any interrupted/cleanStop/exported markers. Factored out of
// _sessionRow so _tickLive() can recompute it for a still-running session
// without rebuilding the row - actualHoursOf()/hoursOf() already read
// Date.now() fresh on every call; something just has to call them again
// and push the result into the widget that's already on screen.
function sessionSubtitle(session) {
    let end = session.endMs === null ? 'now' : clockOf(session.endMs);
    let actual = actualHoursOf(session);
    let billed = hoursOf(session);
    let subtitle = `${clockOf(session.startMs)}–${end}`;
    if (hasBilledHours(session))
        subtitle += `   ${billed.toFixed(2)} h  ←  ${actual.toFixed(2)} h`;
    else
        subtitle += `   ${actual.toFixed(2)} h`;
    if (session.interrupted)
        subtitle += '   · interrupted';
    else if (session.cleanStop)
        subtitle += '   · stopped at shutdown';
    if (session.exportedAt)
        subtitle += '   · exported';
    return subtitle;
}

// Decimal hours for anything being billed; h/m for anything being read.
// Rounds to whole minutes first, then derives hours and minutes from that
// total - rounding each of h and m independently let 3599s print as "60m"
// and 7199s print as "1h 60m".
function formatHours(h) {
    let totalMinutes = Math.round(h * 60);
    let hh = Math.floor(totalMinutes / 60);
    let mm = totalMinutes % 60;
    if (hh >= 1)
        return `${hh}h ${mm}m`;
    return `${mm}m`;
}

// UpdateSession never returns a raw code alone - each of the store's
// rejection reasons (clockStore.js update()) is mapped to a sentence here,
// with a fallback for anything this window doesn't know about yet.
function describeUpdateError(code) {
    switch (code) {
    case 'overlap':
        return 'That would overlap another session.';
    case 'backwards':
        return "The end time can't be before the start.";
    case 'reopen':
        return 'A closed session cannot be reopened from here.';
    case 'exported':
        return 'That session has been exported; moving it to another day would bill it twice. ' +
            'Change it in the invoicing app first.';
    case 'invalid':
        return "That value isn't valid.";
    case 'missing':
        return 'This session no longer exists.';
    default:
        return `Rejected: ${code}`;
    }
}

// ExportPeriod's own validation failure is the one bare code it can return
// (day keys the window itself computed should never trip it); anything else
// in its `error` field already came from Gio.File as a filesystem message
// (e.g. "Permission denied") and reads fine as a sentence on its own.
function describeExportError(code) {
    if (code === 'invalid')
        return "That period isn't valid.";
    return code;
}

export class TimesheetWindow {
    constructor(app) {
        // The session bus itself can be unreachable (not just the Clock
        // object on it), which throws here rather than lazily on first
        // call. Either way the window must still appear, with the error
        // surfaced in place of a session list.
        this._proxy = null;
        let proxyError = null;
        try {
            this._proxy = new ClockProxy(
                Gio.DBus.session, 'org.gnome.Shell',
                '/org/gnome/Shell/Extensions/ScreenTime/Clock');
        } catch (e) {
            proxyError = e;
        }

        this.window = new Adw.ApplicationWindow({
            application: app,
            title: 'Timesheet',
            default_width: 560,
            default_height: 720,
        });

        this._page = new Adw.PreferencesPage();
        let header = new Adw.HeaderBar();
        header.pack_end(this._exportButton());
        let toolbar = new Adw.ToolbarView({ content: this._page });
        toolbar.add_top_bar(header);
        // Every rejection path in this window reports through a toast, so the
        // overlay belongs to the window rather than to a later feature.
        this._toasts = new Adw.ToastOverlay({ child: toolbar });
        this.window.content = this._toasts;

        this._groups = [];
        this._refreshing = false;
        this._refreshPending = false;
        // refresh() tears down and rebuilds every row from the server's
        // copy, so anything the user typed or bumped but hasn't saved yet
        // would otherwise vanish under an unrelated ClockChanged (starting
        // a clock from the panel, another session's Save). Both are owned
        // by the window, not by the widgets they seed, and survive the
        // rebuild: _drafts carries unsaved edits per session id, and
        // _expandedIds carries which rows should come back open, and
        // _activitiesOpen which of their Activities blocks.
        this._drafts = new Map();
        this._expandedIds = new Set();
        this._activitiesOpen = new Set();
        // session id -> live-row bookkeeping for _tickLive(), rebuilt by
        // refresh() on every pass (see there) since the rows themselves are
        // rebuilt too. Ticked on its own timer, independent of ClockChanged
        // and the D-Bus proxy entirely, so it still does something useful
        // (nothing, on an empty map) even when proxyError is set below.
        this._liveRows = new Map();
        this._liveTimerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, LIVE_TICK_SECONDS, () => {
                this._tickLive();
                return GLib.SOURCE_CONTINUE;
            });
        this.window.connect('close-request', () => {
            if (this._liveTimerId) {
                GLib.source_remove(this._liveTimerId);
                this._liveTimerId = null;
            }
            return false;
        });
        if (proxyError) {
            this._showError(`Could not reach the extension: ${proxyError.message}`);
            return;
        }
        this._proxy.connectSignal('ClockChanged', () => this.refresh());
        this.refresh();
    }

    // A menu button rather than a bare "Export…" button: the invoicing
    // app's draft period defaults to last month, but a mid-month check
    // against what's on the clock so far needs this month too.
    _exportButton() {
        let button = new Gtk.MenuButton({ label: 'Export…' });
        let box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 2,
            margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6,
        });
        let popover = new Gtk.Popover({ child: box });
        for (let [label, monthOffset] of [['Last month', -1], ['This month', 0]]) {
            let item = new Gtk.Button({ label, css_classes: ['flat'] });
            item.connect('clicked', () => {
                popover.popdown();
                this._export(monthOffset);
            });
            box.append(item);
        }
        button.set_popover(popover);
        return button;
    }

    // monthOffset is relative to the calendar month containing "now": -1 is
    // last month (the default, matching the invoicing app's draft period),
    // 0 is this month, so a mid-month check against what's on the clock so
    // far is possible. Both day keys are computed from local calendar
    // dates, per ClockStore.sessionsForDays()/ExportPeriod's dayKey
    // selection, not from a millisecond span.
    _export(monthOffset) {
        // The export button stays visible even when the session bus proxy
        // failed to construct (the window still shows an error in place of
        // the session list in that case) - guard here rather than let a
        // null-proxy TypeError surface as the toast's text.
        if (!this._proxy) {
            this._toast('Could not reach the extension.');
            return;
        }
        let now = GLib.DateTime.new_now_local();
        let firstOfThisMonth = GLib.DateTime.new_local(now.get_year(), now.get_month(), 1, 0, 0, 0);
        let from = firstOfThisMonth.add_months(monthOffset);
        let toExclusive = from.add_months(1);
        let fromDayKey = from.format('%Y-%m-%d');
        let toDayKeyExclusive = toExclusive.format('%Y-%m-%d');

        let dialog = new Gtk.FileDialog({
            title: 'Export time entries',
            initial_name: `time-${from.format('%Y-%m')}.json`,
        });
        dialog.save(this.window, null, (source, result) => {
            let file;
            try {
                file = source.save_finish(result);
            } catch (e) {
                return;   // cancelled
            }
            let path = file.get_path();
            // null for a location with no local path - a GVFS/remote
            // location (SFTP, a cloud-storage mount) browsed through the
            // picker without ever resolving to one. ExportPeriod also
            // refuses a non-absolute path (see ClockDBus's
            // GLib.path_is_absolute() check), but null.endsWith() below
            // would throw first, outside the try that reports everything
            // else here as a toast.
            if (path === null) {
                this._toast('Export failed: pick a location on this computer.');
                return;
            }
            let format = path.endsWith('.csv') ? 'csv' : 'json';
            try {
                let [json] = this._proxy.ExportPeriodSync(
                    fromDayKey, toDayKeyExclusive, path, format);
                let result2 = JSON.parse(json);
                // Sessions skipped because their client isn't on the list at
                // all (most likely deleted from Preferences - see
                // clients.js's isKnownClient and prefs.js's confirm-delete
                // dialog), not the non-billable ones selectExportable()
                // deliberately drops without a word. Appended to whichever
                // branch below actually reports success, so it never appears
                // alongside an outright failure that wrote nothing.
                let skippedNote = result2.skippedUnknown > 0
                    ? ` ${result2.skippedUnknown} session(s) skipped for an unknown client.`
                    : '';
                if (result2.error) {
                    this._toast(`Export failed: ${describeExportError(result2.error)}`);
                } else if (result2.recorded === false) {
                    // The file itself was written fine; only the in-store
                    // exportedAt stamps couldn't reach disk (ClockStore is
                    // read-only - see clockStore.js), so the Timesheet's
                    // "· exported" marker for these sessions won't survive
                    // a Shell restart. Surfaced here rather than left in
                    // the journal, which isn't somewhere a user looks.
                    this._toast(`Exported ${result2.rows} row(s) to ${path}, ` +
                        `but couldn't record the export against the sessions.${skippedNote}`);
                } else {
                    this._toast(`Exported ${result2.rows} row(s) to ${path}${skippedNote}`);
                }
            } catch (e) {
                this._toast(`Export failed: ${e.message}`);
            }
        });
    }

    // Everything the Shell holds from the first day of last month to now.
    // The Shell is the only writer, so this process never reads a file.
    //
    // Anchored to a calendar boundary, not a fixed span: the "Last month"
    // export (_export(), above) can reach back up to ~61 days (the 1st of
    // last month, from as late as the last day of this month), and a fixed
    // 30-day window would let the start of that period be exported without
    // ever being reviewable here. Recomputed on every refresh() rather than
    // cached, so the window doesn't need its own day-rollover timer to
    // notice midnight passing while it's open.
    //
    // ClockChanged fires on every Save and "Use actual" now, and this method
    // makes a blocking call in the middle of rebuilding _groups; a second,
    // overlapping refresh() would duplicate day groups. A refresh requested
    // while one is already running is not dropped, though - it is the one
    // reflecting whatever just changed, so it is coalesced into a single
    // follow-up run once the current one finishes. Several requests that
    // arrive during one refresh collapse into that one extra pass rather
    // than one apiece.
    refresh() {
        if (this._refreshing) {
            this._refreshPending = true;
            return;
        }
        this._refreshing = true;
        try {
            for (let group of this._groups.splice(0))
                this._page.remove(group);
            // Every row is about to be rebuilt from scratch (below), so any
            // live-row bookkeeping from the previous pass points at widgets
            // that no longer exist - _sessionRow()/_adjustRows() repopulate
            // this for whatever is still running.
            this._liveRows.clear();

            let to = Date.now();
            let now = GLib.DateTime.new_now_local();
            let firstOfThisMonth = GLib.DateTime.new_local(now.get_year(), now.get_month(), 1, 0, 0, 0);
            let from = firstOfThisMonth.add_months(-1).to_unix() * 1000;
            let sessions;
            try {
                let [json] = this._proxy.GetSessionsSync(from, to);
                sessions = JSON.parse(json);
            } catch (e) {
                this._showError(`Could not reach the extension: ${e.message}`);
                return;
            }
            // GetSessions() has no error reply today (unlike GetEvidence
            // and UpdateSession), but guard anyway: an unexpected
            // non-array JSON.parse() result (an {error} object, say, if
            // that ever changes) must not reach sessions.map() below or
            // _previousEndFor(), both of which assume an array.
            if (!Array.isArray(sessions)) {
                this._showError('Could not reach the extension: unexpected response.');
                return;
            }
            // Kept for _previousEndFor(), which snaps a start time to the
            // end of the session before it - possibly on an earlier day,
            // so it needs the whole fetched window, not just one day's
            // group.
            this._sessions = sessions;

            // Drop state for sessions that fell out of the 30-day window or
            // were deleted, so this never grows without bound and a stale
            // draft can never reattach to a reused id.
            let currentIds = new Set(sessions.map(s => s.id));
            for (let id of this._drafts.keys()) {
                if (!currentIds.has(id))
                    this._drafts.delete(id);
            }
            for (let id of this._expandedIds) {
                if (!currentIds.has(id))
                    this._expandedIds.delete(id);
            }

            if (sessions.length === 0) {
                this._showError('Nothing on the clock yet. Start a client from the panel.');
                return;
            }

            let byDay = new Map();
            for (let session of sessions) {
                if (!byDay.has(session.dayKey))
                    byDay.set(session.dayKey, []);
                byDay.get(session.dayKey).push(session);
            }

            for (let [dayKey, daySessions] of [...byDay].reverse()) {
                // Whole milliseconds summed, then rounded once - see
                // sessionMs() above - so this total never quietly disagrees
                // with mergeSessions()'s own row for the same day by the
                // ~0.01h a per-session float sum can drift by.
                let totalMs = daySessions.reduce((sum, s) => sum + sessionMs(s), 0);
                let billed = Math.round(totalMs / 36000) / 100;
                let group = new Adw.PreferencesGroup({
                    title: dayKey,
                    description: `${billed.toFixed(2)} h`,
                });
                for (let session of daySessions)
                    group.add(this._sessionRow(session));
                this._page.add(group);
                this._groups.push(group);
            }
        } finally {
            this._refreshing = false;
            if (this._refreshPending) {
                this._refreshPending = false;
                this.refresh();
            }
        }
    }

    // cleanStop is set only by ClockStore.closeForShutdown(), which now
    // runs only from the `global` 'shutdown' handler in extension.js (a
    // real logout or full shutdown/reboot) - never from a lock, an idle
    // blank or a suspend, which leave the session open instead (see
    // ClockStore.release()). "interrupted" covers what's left: the Shell
    // went away with no clean goodbye at all - a crash, or a logout/
    // shutdown whose 'shutdown' handler didn't run in time.
    _sessionRow(session) {
        let row = new Adw.ExpanderRow({
            title: session.client,
            subtitle: sessionSubtitle(session),
            css_classes: session.exportedAt ? ['dim-label'] : [],
        });

        // Bookkeeping for _tickLive(): only a still-running session's
        // figures go stale between refreshes (nothing mutates the clock
        // just because time passes, so nothing fires ClockChanged to
        // trigger a refresh() on its own), so only these get an entry.
        // clockLabel/hours/draft start null and are filled in by
        // _fillEvidence()/_adjustRows() below once the row is actually
        // expanded - until then there is nothing more for a tick to
        // update than the subtitle already covers.
        let live = null;
        if (session.endMs === null) {
            live = { session, row, clockLabel: null, hours: null, draft: null };
            this._liveRows.set(session.id, live);
        }

        // Evidence is fetched on expand, not up front: a month of sessions
        // would otherwise mean a month of range queries to draw one list.
        let loaded = false;
        row.connect('notify::expanded', () => {
            if (row.expanded)
                this._expandedIds.add(session.id);
            else
                this._expandedIds.delete(session.id);
            if (!row.expanded || loaded)
                return;
            loaded = true;
            this._fillEvidence(row, session, live);
        });
        // refresh() rebuilds this row from scratch, so a row the user had
        // open is re-expanded here rather than coming back collapsed -
        // which in turn re-fires the handler above and re-fetches its
        // evidence, same as a first-time expand.
        if (this._expandedIds.has(session.id))
            row.expanded = true;
        return row;
    }

    _fillEvidence(row, session, live) {
        let evidence;
        try {
            let [json] = this._proxy.GetEvidenceSync(session.id);
            evidence = JSON.parse(json);
        } catch (e) {
            row.add_row(new Adw.ActionRow({ title: `Could not read evidence: ${e.message}` }));
            return;
        }
        if (evidence.error === 'span') {
            // Refused server-side (ClockDBus's MAX_EVIDENCE_SPAN_MS) rather
            // than walking a day-by-day query across an implausible range -
            // likely a start or end time far from reality (a bad manual
            // edit, say). Still render the Started/Ended/Bill fields below
            // with a synthetic, empty evidence shape, so the session stays
            // fixable from here instead of becoming a dead end.
            row.add_row(new Adw.ActionRow({
                title: "Evidence isn't shown for this session",
                subtitle: "Its span is too large to query safely - likely a start or end " +
                    'time far from reality. Fix it below, then reopen this row.',
            }));
            evidence = {
                entries: [], unattributedSeconds: 0, firstActivityMs: null,
                spanSeconds: Math.max(0, Math.round(
                    ((session.endMs ?? Date.now()) - session.startMs) / 1000)),
            };
        } else if (evidence.error) {
            row.add_row(new Adw.ActionRow({ title: 'This session is no longer available.' }));
            return;
        }

        // One draft per session backs the Started/Ended fields below and
        // the Note/Bill fields in _adjustRows, so all five widgets agree on
        // what the user has and hasn't touched yet.
        let draft = this._draftFor(session);
        if (live)
            live.draft = draft;

        row.add_row(this._timeRow(session, evidence, draft, 'start'));
        if (session.endMs !== null)
            row.add_row(this._timeRow(session, evidence, draft, 'end'));

        // Activities sit between Bill and Note: the evidence for adjusting
        // the one and for writing the other.
        let [billRow, noteRow] = this._adjustRows(session, evidence, draft, live);
        row.add_row(billRow);
        if (evidence.entries.length > 0 || evidence.unattributedSeconds > 0)
            row.add_row(this._activityRow(session, evidence));
        row.add_row(noteRow);
    }

    // Epoch ms -> "HH:MM" and back, resolved against the session's own day so
    // typing 09:15 cannot silently move the session to today.
    //
    // Backed by `draft` (see _draftFor) rather than the session directly:
    // text the user has typed but not yet applied (no Enter pressed yet)
    // must survive a refresh the same way the Note field's unsaved text
    // does, since ClockChanged - fired by Save, "Use actual", or any other
    // client mutating the clock, including from the panel or the Shell's
    // own toggle-clock shortcut, but NOT by the clock's own 30s heartbeat,
    // which never touches onChange at all - can rebuild this row at any
    // time.
    _timeRow(session, evidence, draft, which) {
        let draftKey = which === 'start' ? 'start' : 'end';
        let dirtyKey = which === 'start' ? 'startDirty' : 'endDirty';
        let current = which === 'start' ? session.startMs : session.endMs;

        let row = new Adw.EntryRow({
            title: which === 'start' ? 'Started' : 'Ended',
        });
        // Seeded from the draft, then the dirty-tracking handler is
        // connected - same ordering as _adjustRows's Note/Bill fields, so
        // seeding this text never itself marks the field dirty.
        row.text = draft[draftKey];
        row.connect('notify::text', () => {
            draft[draftKey] = row.text;
            draft[dirtyKey] = true;
        });

        let apply = ms => {
            let fields = which === 'start' ? { startMs: ms } : { endMs: ms };
            try {
                let [json] = this._proxy.UpdateSessionSync(
                    session.id, JSON.stringify(fields));
                let result = JSON.parse(json);
                if (result.error) {
                    this._toast(describeUpdateError(result.error));
                    return;
                }
                // Applied: the server's copy is now the truth and the
                // ClockChanged this triggers will rebuild this row, so the
                // draft must stop pinning the text that was just sent -
                // otherwise the next render would show what was typed
                // instead of re-seeding from the session's new value.
                draft[dirtyKey] = false;
                this._toastIfUnsaved(result);
            } catch (e) {
                this._toast(`Failed: ${e.message}`);
            }
        };

        row.connect('apply', () => {
            let ms = parseClock(row.text, current ?? session.startMs);
            if (ms === null) {
                this._toast('Enter a time as HH:MM.');
                return;
            }
            apply(ms);
        });

        if (which === 'start') {
            let firstActivity = evidence.firstActivityMs ?? null;
            if (firstActivity !== null && firstActivity > session.startMs) {
                let snap = new Gtk.Button({
                    label: `Snap to ${clockOf(firstActivity)}`,
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Move the start to the first activity recorded in this session.',
                });
                snap.connect('clicked', () => apply(firstActivity));
                row.add_suffix(snap);
            }
            let previousEnd = this._previousEndFor(session);
            if (previousEnd !== null && previousEnd !== session.startMs) {
                let butt = new Gtk.Button({
                    label: `Snap to ${clockOf(previousEnd)}`,
                    css_classes: ['flat'],
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Start where the previous session ended.',
                });
                butt.connect('clicked', () => apply(previousEnd));
                row.add_suffix(butt);
            }
        }
        return row;
    }

    // The end of the latest session that finished at or before this one
    // started, which is what "I forgot to switch" should snap to.
    _previousEndFor(session) {
        let best = null;
        for (let other of this._sessions ?? []) {
            if (other.id === session.id || other.endMs === null)
                continue;
            if (other.endMs <= session.startMs && (best === null || other.endMs > best))
                best = other.endMs;
        }
        return best;
    }

    // The session's recorded activity as one compact block under a
    // collapsible "Activities" heading, rather than a full-height row per
    // app: one small line per app, with its activities (and theirs)
    // indented below it, biggest first. Collapsed until opened, and kept
    // open across refresh() the same way an expanded session row is (see
    // _sessionRow).
    _activityRow(session, evidence) {
        let lines = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2,
            margin_top: 4,
        });
        let add = (node, depth) => {
            lines.append(activityLine(node.displayName, node.seconds, depth));
            Object.values(node.children ?? {})
                .sort((a, b) => b.seconds - a.seconds)
                .forEach(child => add(child, depth + 1));
        };
        for (let entry of evidence.entries)
            add(entry, 0);
        if (evidence.unattributedSeconds > 0) {
            let unattributed = activityLine('Unattributed', evidence.unattributedSeconds, 0);
            unattributed.add_css_class('dim-label');
            unattributed.tooltip_text = 'No focused window, or away. ' +
                'Undercounts a walk-away by up to one idle timeout.';
            lines.append(unattributed);
        }

        let expander = new Gtk.Expander({
            label_widget: new Gtk.Label({
                label: 'Activities',
                css_classes: ['caption', 'dim-label'],
            }),
            child: lines,
            expanded: this._activitiesOpen.has(session.id),
            margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12,
        });
        expander.connect('notify::expanded', () => {
            if (expander.expanded)
                this._activitiesOpen.add(session.id);
            else
                this._activitiesOpen.delete(session.id);
        });
        return new Adw.PreferencesRow({ activatable: false, child: expander });
    }

    // Gets or creates the draft for `session` (this._drafts, keyed by
    // session id) and re-seeds every field the user has NOT touched from
    // the session's current data, before returning it.
    //
    // A draft is created empty on a row's first expansion and would
    // otherwise keep whatever it was first seeded with forever: refresh()
    // rebuilds this row from scratch on every ClockChanged - fired on every
    // Save, "Use actual", and any other client mutating the clock, but
    // never by the clock's own 30s heartbeat, which does not touch
    // onChange - and an untouched field must track the session, not freeze
    // at its first-render value. That alone is not enough for a session
    // that is still running, though: nothing mutates the clock (so nothing
    // fires ClockChanged, so refresh() never runs) just because time keeps
    // passing. _tickLive() below is what actually keeps a running session's
    // figures current between those refreshes: expand it at 1.0 h, leave
    // the row open while the clock runs to 2.0 h, and the next tick has
    // already moved draft.hours and the spin button to 2.0 h by the time
    // +1/4 is pressed, sending 2.25 rather than a stale 1.25. A field the
    // user HAS edited (its dirty flag is true) is left alone - that's an
    // in-progress edit, not something to overwrite - and clearing dirty on
    // a successful save is exactly what hands the field back to being
    // re-seeded here.
    _draftFor(session) {
        let draft = this._drafts.get(session.id);
        if (!draft) {
            draft = {
                note: '', hours: 0, noteDirty: false, hoursDirty: false,
                start: '', startDirty: false, end: '', endDirty: false,
            };
            this._drafts.set(session.id, draft);
        }
        if (!draft.noteDirty)
            draft.note = session.description;
        if (!draft.hoursDirty)
            draft.hours = hoursOf(session);
        if (!draft.startDirty)
            draft.start = clockOf(session.startMs);
        if (!draft.endDirty)
            draft.end = session.endMs === null ? '' : clockOf(session.endMs);
        return draft;
    }

    // Returns the Bill row and the Note row together, so the caller adds
    // both without either method reaching into the other's state.
    //
    // Both widgets are backed by `draft` (see _draftFor), not by the
    // widgets themselves: refresh() rebuilds this row from scratch on every
    // ClockChanged, so anything typed or bumped but not yet saved must
    // survive that rebuild rather than being seeded back to the server's
    // last-saved values.
    _adjustRows(session, evidence, draft, live) {
        let noteRow = new Adw.EntryRow({ title: 'Note' });
        // Starts from the session's saved note only, never from the
        // activities above: those are repository names, hostnames and
        // subreddits, not something to put on an invoice.
        noteRow.text = draft.note;

        let hours = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                // 24 would clamp a clock left running over a weekend to
                // "24.00 h", and Save would then write that ceiling as
                // billedHours - permanently discarding the true value.
                lower: 0, upper: 999, step_increment: 0.25, page_increment: 1,
                value: draft.hours,
            }),
            digits: 2,
            valign: Gtk.Align.CENTER,
        });

        // Connected after both widgets are seeded from the draft above, so
        // restoring a draft (or seeding a fresh one) never itself marks
        // anything dirty - only an edit the user makes here does.
        noteRow.connect('notify::text', () => {
            draft.note = noteRow.text;
            draft.noteDirty = true;
        });
        // The Bill control's edits go through HoursBinding, which tells a
        // person's change apart from _tickLive()'s own refresh: GTK fires
        // value-changed for both, and only the first may mark hours edited.
        let binding = new HoursBinding(hours.adjustment, draft);

        // Renamed from "Reset" and moved away from Save: it sends
        // billedHours alone (the note is left untouched, since
        // UpdateSession only touches fields present in the payload), so a
        // misclick next to Save no longer discards an adjustment with no
        // way back.
        let useActual = new Gtk.Button({ label: 'Use actual', css_classes: ['flat'] });
        useActual.connect('clicked', () => this._updateSession(session, { billedHours: null }));

        let controls = new Gtk.Box({ spacing: 6 });
        controls.append(useActual);
        controls.append(hours);
        for (let [label, delta] of [['¼', 0.25], ['½', 0.5], ['+1', 1]]) {
            let button = new Gtk.Button({ label, css_classes: ['flat'] });
            button.connect('clicked', () => { hours.value += delta; });
            controls.append(button);
        }
        let round = new Gtk.Button({ label: 'Round', css_classes: ['flat'] });
        round.connect('clicked', () => {
            hours.value = Math.round(hours.value * 4) / 4;
        });
        controls.append(round);
        // Save sits at the far end, well away from "Use actual".
        controls.append(new Gtk.Box({ hexpand: true }));

        let save = new Gtk.Button({ label: 'Save', css_classes: ['suggested-action'] });
        save.connect('clicked', () => {
            // Only what was actually edited: see saveFields.
            let fields = saveFields(draft, hours.value, noteRow.text);
            if (Object.keys(fields).length === 0) {
                this._toast('Nothing to save.');
                return;
            }
            this._updateSession(session, fields);
        });
        controls.append(save);

        // Two lines of its own - the heading, then the controls - rather
        // than an ActionRow suffix, which squeezed the title into a sliver
        // beside this many controls. The heading matches the Started,
        // Ended and Note titles.
        let heading = new Gtk.Label({
            label: billHeading(evidence.spanSeconds / 3600),
            xalign: 0,
            css_classes: ['caption', 'dim-label'],
        });
        let billBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12,
        });
        billBox.append(heading);
        billBox.append(controls);
        let billRow = new Adw.PreferencesRow({ activatable: false, child: billBox });

        // Handed to _tickLive() (only non-null for a still-running
        // session - see _sessionRow): this heading's "X h on the clock" and
        // the spin button's value are exactly the two figures that
        // otherwise freeze at whatever they were on expand, per the class
        // comment on _draftFor.
        if (live) {
            live.clockLabel = heading;
            live.hours = hours;
            live.binding = binding;
        }

        return [billRow, noteRow];
    }

    // Recomputes every currently-running session's row locally, every
    // LIVE_TICK_SECONDS, with no D-Bus call at all: hoursOf()/
    // actualHoursOf() already read Date.now() fresh on every call, so the
    // numbers that would otherwise freeze at whatever they were on the last
    // refresh() or expand (see the comments on _timeRow and _draftFor) just
    // need recomputing and pushing back into the widgets that are already
    // on screen - a subtitle string, an ActionRow subtitle, a spin button's
    // value - never a rebuild.
    _tickLive() {
        for (let live of this._liveRows.values()) {
            let { session, row, clockLabel, hours, binding, draft } = live;
            row.subtitle = sessionSubtitle(session);
            if (!clockLabel || !hours || !binding || !draft)
                continue;   // not expanded (yet): nothing else to refresh
            clockLabel.label = billHeading(actualHoursOf(session));
            // hoursOf() returns the fixed billedHours override unchanged
            // when one is set, and the live elapsed time otherwise - the
            // same rule _draftFor() re-seeds an untouched draft with, so a
            // manual override here is left exactly as billed, not walked
            // forward every tick.
            // Through the binding, so this refresh isn't taken for an edit
            // (setting the value directly fires value-changed, which marked
            // the hours edited and let a note-only Save pin them), and not
            // while the person is typing in the control.
            binding.refresh(hoursOf(session), { focused: hasFocusWithin(hours) });
        }
    }

    // Shared by Save and "Use actual": both send a partial fields payload
    // and report a rejection through a toast. A successful update fires
    // ClockChanged, which rebuilds this row from the server's copy, so only
    // the dirty flag(s) for the field(s) this call actually wrote are
    // cleared here - that hands them back to _draftFor to re-seed from the
    // session on the rebuild. Fields this call did NOT touch (an
    // un-applied Started/Ended edit sitting in the row while only Save's
    // Note/Bill fields were sent, say) are left dirty, with their draft
    // text untouched: deleting the whole draft here, as before adding
    // Started/Ended, would otherwise discard that unrelated unsaved edit -
    // exactly what _drafts exists to prevent. A rejected or failed call
    // leaves every flag as it was, so nothing typed is lost.
    _updateSession(session, fields) {
        try {
            let [json] = this._proxy.UpdateSessionSync(session.id, JSON.stringify(fields));
            let result = JSON.parse(json);
            if (result.error) {
                this._toast(describeUpdateError(result.error));
                return;
            }
            let draft = this._drafts.get(session.id);
            if (draft) {
                if ('billedHours' in fields)
                    draft.hoursDirty = false;
                if ('description' in fields)
                    draft.noteDirty = false;
            }
            this._toastIfUnsaved(result);
        } catch (e) {
            this._toast(`Failed: ${e.message}`);
        }
    }

    // Called after a mutating UpdateSessionSync reply that did NOT report
    // an error: the edit landed in the store's memory, but result.saved is
    // false when it didn't actually reach clock.json (ClockStore.readOnly
    // or saveFailing - see clockDBus.js's _saved()). Silent otherwise -
    // most edits show no toast at all today, and a healthy save must not
    // start showing one.
    _toastIfUnsaved(result) {
        if (result.saved === false) {
            this._toast("Saved here, but clock.json couldn't be written - it won't survive " +
                'a restart. Check the Shell\'s logs.');
        }
    }

    _toast(text) {
        this._toasts.add_toast(new Adw.Toast({ title: text }));
    }

    _showError(text) {
        let group = new Adw.PreferencesGroup();
        group.add(new Adw.ActionRow({ title: text }));
        this._page.add(group);
        this._groups.push(group);
    }
}
