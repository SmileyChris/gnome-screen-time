import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk?version=4.0';
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
import { HoursBinding } from './timesheetDraft.js';
import { dayHeading } from './timesheetSummary.js';
import { buildClientsPage } from './clientsPage.js';
import { readProjects } from './clients.js';

const ClockProxy = Gio.DBusProxy.makeProxyWrapper(INTERFACE_XML);

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

function hoursOf(session) {
    if (hasBilledHours(session))
        return session.billedHours;
    return ((session.endMs ?? Date.now()) - session.startMs) / 3600000;
}

function actualHoursOf(session) {
    return ((session.endMs ?? Date.now()) - session.startMs) / 3600000;
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

// A session row's times, shown at the right of its title line so a row
// takes one line unless it has something to flag. _tickLive() recomputes
// it for a running session: actualHoursOf() reads Date.now() fresh.
function sessionTimes(session) {
    let end = session.endMs === null ? 'now' : clockOf(session.endMs);
    let actual = actualHoursOf(session);
    let times = `${clockOf(session.startMs)}–${end}  ${actual.toFixed(2)}h`;
    // Actual first, then what it was adjusted to, read left to right.
    if (hasBilledHours(session))
        return `${times} → ${hoursOf(session).toFixed(2)}h`;
    return times;
}

// The flags the subtitle carries, empty for most rows.
function sessionFlags(session) {
    let flags = [];
    if (session.interrupted)
        flags.push('interrupted');
    else if (session.cleanStop)
        flags.push('stopped at shutdown');
    if (session.exportedAt)
        flags.push('exported');
    return flags.join(' · ');
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
        return 'That session has been exported; moving it to another day would export it twice. ' +
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
    constructor(app, settings) {
        // Kept for _projectRow(), which reads a client's project list
        // straight from GSettings rather than over D-Bus - the Shell owns
        // no such call, and the Timesheet already reads settings directly
        // for the Clients page (buildClientsPage, below).
        this._settings = settings;

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

        // Session rows carry one line of text, so their header drops the
        // two-line row height libadwaita gives every row.
        let css = new Gtk.CssProvider();
        css.load_from_string(
            'row.session-row > box > list > row.header { min-height: 0; }' +
            'row.session-row > box > list > row.header > box.header ' +
            '{ min-height: 0; padding-top: 4px; padding-bottom: 4px; }' +
            // A collapsed row's note, shaded like the opened section it
            // stands in for (libadwaita's row.expander list.nested).
            'row.session-row .session-note { padding: 6px 12px; ' +
            'background-color: color-mix(in srgb, var(--card-shade-color) 50%, transparent); }' +
            // On a list's last row the note, not the header, meets the
            // rounded bottom edge.
            'list.boxed-list > row.session-row.with-note:last-child row.header ' +
            '{ border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom-width: 1px; }' +
            'list.boxed-list > row.session-row:last-child .session-note ' +
            '{ border-bottom-left-radius: 12px; border-bottom-right-radius: 12px; }');
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this.window = new Adw.ApplicationWindow({
            application: app,
            title: 'Timesheet',
            default_width: 560,
            default_height: 720,
        });

        this._page = new Adw.PreferencesPage();
        // Sessions and Clients share the window; the clock's settings live
        // here rather than in Preferences, which is about screen time.
        this._stack = new Adw.ViewStack();
        this._stack.add_titled_with_icon(this._page, 'sessions', 'Sessions',
            'x-office-spreadsheet-symbolic');
        let clients = buildClientsPage(settings, this.window);
        this._focusAddClient = clients.focusAddClient;
        this._stack.add_titled_with_icon(clients.page, 'clients', 'Clients',
            'system-users-symbolic');

        let header = new Adw.HeaderBar({
            title_widget: new Adw.ViewSwitcher({
                stack: this._stack,
                policy: Adw.ViewSwitcherPolicy.WIDE,
            }),
        });
        let exportButton = this._exportButton();
        header.pack_end(exportButton);
        // Export covers sessions only.
        this._stack.connect('notify::visible-child-name', () => {
            exportButton.visible = this._stack.visible_child_name === 'sessions';
        });
        let toolbar = new Adw.ToolbarView({ content: this._stack });
        toolbar.add_top_bar(header);
        // Every rejection path in this window reports through a toast, so the
        // overlay belongs to the window rather than to a later feature.
        this._toasts = new Adw.ToastOverlay({ child: toolbar });
        this.window.content = this._toasts;

        this._groups = [];
        // The day showDay() asked to scroll to, held until the list has
        // been drawn (see _scrollToPendingDaySoon()).
        this._pendingDay = null;
        this._refreshing = false;
        this._refreshPending = false;
        // refresh() tears down and rebuilds every row from the server's
        // copy, so anything the user typed or bumped but hasn't saved yet
        // would otherwise vanish under an unrelated ClockChanged (starting
        // a clock from the panel, another session's field saving itself).
        // Both are owned by the window, not by the widgets they seed, and
        // survive the rebuild: _drafts carries unsaved edits per session id, and
        // _expandedIds carries which rows should come back open, and
        // _activitiesOpen which of their Activities blocks.
        this._drafts = new Map();
        this._expandedIds = new Set();
        this._activitiesOpen = new Set();
        // Which editable field (if any) has keyboard focus when a rebuild
        // starts, keyed by "<session id>:<field>" - see _registerFocusField,
        // _focusedFieldKey and _restoreFocus. Every field that can save
        // itself now does so on Enter or on losing focus (there is no Save
        // button any more), so a rebuild triggered by the very save the
        // person just made must not be what yanks focus out from under them.
        this._focusFields = new Map();
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
                // all (most likely deleted from the Timesheet's Clients page
                // - see clients.js's isKnownClient and clientsPage.js's
                // confirm-delete dialog). Appended to whichever branch below
                // actually reports success, so it never appears alongside an
                // outright failure that wrote nothing.
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
    // ClockChanged fires on every self-save and "Use actual" now, and this method
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
        // Every field saves itself and can trigger this very rebuild (see
        // the constructor's comment on _focusFields), so whichever one the
        // person is sitting in has to be found now, before it is torn down
        // below - get_focus() can no longer answer this once it's gone.
        let focusedKey = this._focusedFieldKey();
        try {
            for (let group of this._groups.splice(0))
                this._page.remove(group);
            // Every row is about to be rebuilt from scratch (below), so any
            // live-row bookkeeping from the previous pass points at widgets
            // that no longer exist - _sessionRow()/_adjustRows() repopulate
            // this for whatever is still running.
            this._liveRows.clear();
            this._focusFields.clear();

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
                // Each client's hours, then the total when more than one
                // client worked. timesheetSummary.js rounds them the same
                // way the export rounds its rows.
                let group = new Adw.PreferencesGroup({
                    title: dayKey,
                    description: dayHeading(daySessions),
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
            // A refresh that lands before the scroll rebuilt the groups;
            // aim at the new ones.
            this._scrollToPendingDaySoon();
            // Rows that were expanded re-fetch their evidence synchronously
            // as they're rebuilt above (_sessionRow re-expands them, which
            // fires _fillEvidence inline), so the field named by focusedKey
            // already exists again by this point if it's coming back at all.
            this._restoreFocus(focusedKey);
        }
    }

    // Notes `widget` as the thing to refocus after a rebuild if it's the one
    // that currently has focus - called as each editable field is built, so
    // _focusedFieldKey()/_restoreFocus() (both above, in refresh()) never
    // have to know each row's shape, only its session id and field name.
    _registerFocusField(session, field, widget) {
        this._focusFields.set(`${session.id}:${field}`, widget);
    }

    // The "<session id>:<field>" key of whichever registered field currently
    // holds keyboard focus, or null. is_ancestor() rather than a plain
    // equality check because a SpinButton's own focus sits on an internal
    // text widget, not the SpinButton itself.
    _focusedFieldKey() {
        let focus = this.window.get_focus();
        if (!focus)
            return null;
        for (let [key, widget] of this._focusFields) {
            if (focus === widget || focus.is_ancestor(widget))
                return key;
        }
        return null;
    }

    // Hands focus back to `key`'s field once the rebuild that scattered
    // _focusFields has repopulated it - a no-op if that field didn't come
    // back at all (its session scrolled out of the fetched window, or its
    // row is no longer expanded).
    _restoreFocus(key) {
        if (!key)
            return;
        let widget = this._focusFields.get(key);
        if (!widget)
            return;
        widget.grab_focus();
        if (widget.set_position)
            widget.set_position(-1);
    }

    // Scrolls so `dayKey`'s heading sits at the top of the list, for the
    // popup's "Clocked" card (see timesheet.js). A day outside the list
    // (before the start of last month) leaves it where it is, and null does
    // nothing.
    showDay(dayKey) {
        this._pendingDay = dayKey;
        this._scrollToPendingDaySoon();
    }

    // Switches to `name`'s page; on Clients, the add field takes focus so a
    // name can be typed straight away (the popup's "Add client…").
    showPage(name) {
        this._stack.visible_child_name = name;
        if (name === 'clients')
            this._focusAddClient();
    }

    // Waits for a drawn, laid-out window, so the group's position is known.
    // The window may not be shown yet when showDay() is first called.
    _scrollToPendingDaySoon() {
        if (!this._pendingDay)
            return;
        let afterPaint = () => {
            let frameClock = this.window.get_frame_clock();
            let paintId = frameClock.connect('after-paint', () => {
                frameClock.disconnect(paintId);
                this._scrollToPendingDay();
            });
            this.window.queue_draw();
        };
        if (this.window.get_mapped()) {
            afterPaint();
        } else {
            let mapId = this.window.connect('map', () => {
                this.window.disconnect(mapId);
                afterPaint();
            });
        }
    }

    _scrollToPendingDay() {
        let dayKey = this._pendingDay;
        if (!dayKey)
            return;
        this._pendingDay = null;
        let group = this._groups.find(g => g.title === dayKey);
        let scroller = group?.get_ancestor(Gtk.ScrolledWindow);
        let [ok, rect] = scroller ? group.compute_bounds(scroller) : [false, null];
        if (ok)
            scroller.vadjustment.value += rect.get_y();
    }

    // cleanStop is set only by ClockStore.closeForShutdown(), which now
    // runs only from the `global` 'shutdown' handler in extension.js (a
    // real logout or full shutdown/reboot) - never from a lock, an idle
    // blank or a suspend, which leave the session open instead (see
    // ClockStore.release()). "interrupted" covers what's left: the Shell
    // went away with no clean goodbye at all - a crash, or a logout/
    // shutdown whose 'shutdown' handler didn't run in time.
    _sessionRow(session) {
        // A long note stays on one line.
        let row = new Adw.ExpanderRow({ use_markup: false, subtitle_lines: 1 });
        // Notes, client and project names are free text, not Pango markup.
        // Set after construction: passed to the constructor, they are
        // parsed as markup before use_markup takes effect.
        row.title = session.project ? `${session.client} · ${session.project}` : session.client;
        row.subtitle = sessionFlags(session);

        // Collapsed, the note shows beneath the header in the opened
        // section's shade, so it reads as the row's content rather than
        // part of its title line; open, the Note field shows it instead.
        // It goes inside the row's own box, after the header's list, so it
        // stays within the row's rounded border.
        let noteText = session.description.trim();
        let note = new Gtk.Label({
            label: noteText,
            xalign: 0,
            ellipsize: Pango.EllipsizeMode.END,
            css_classes: ['session-note', 'caption'],
        });
        let rowBox = row.get_first_child();
        rowBox.insert_child_after(note, rowBox.get_first_child());
        let syncNote = () => {
            let shown = noteText !== '' && !row.expanded;
            note.visible = shown;
            if (shown)
                row.add_css_class('with-note');
            else
                row.remove_css_class('with-note');
        };
        syncNote();
        // Added, not set through css_classes: that would replace the row's
        // own "expander" class, which is what turns its arrow when opened.
        row.add_css_class('session-row');
        if (session.exportedAt)
            row.add_css_class('dim-label');
        let times = new Gtk.Label({
            label: sessionTimes(session),
            css_classes: ['dim-label', 'numeric'],
        });
        row.add_suffix(times);

        // Bookkeeping for _tickLive(): only a still-running session's
        // times go stale between refreshes (nothing mutates the clock just
        // because time passes, so nothing fires ClockChanged to trigger a
        // refresh() on its own), so only these get an entry.
        if (session.endMs === null)
            this._liveRows.set(session.id, { session, times });

        // Evidence is fetched on expand, not up front: a month of sessions
        // would otherwise mean a month of range queries to draw one list.
        let loaded = false;
        row.connect('notify::expanded', () => {
            syncNote();
            if (row.expanded)
                this._expandedIds.add(session.id);
            else
                this._expandedIds.delete(session.id);
            if (!row.expanded || loaded)
                return;
            loaded = true;
            this._fillEvidence(row, session);
        });
        // refresh() rebuilds this row from scratch, so a row the user had
        // open is re-expanded here rather than coming back collapsed -
        // which in turn re-fires the handler above and re-fetches its
        // evidence, same as a first-time expand.
        if (this._expandedIds.has(session.id))
            row.expanded = true;
        return row;
    }

    _fillEvidence(row, session) {
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

        row.add_row(this._timeRow(session, evidence, draft));

        let projectRow = this._projectRow(session);
        if (projectRow)
            row.add_row(projectRow);

        // Activities sit between Bill and Note: the evidence for adjusting
        // the one and for writing the other.
        let [billRow, noteRow] = this._adjustRows(session, draft);
        if (billRow)
            row.add_row(billRow);
        if (evidence.entries.length > 0 || evidence.unattributedSeconds > 0)
            row.add_row(this._activityRow(session, evidence));
        row.add_row(noteRow);
    }

    // Started and Ended on one line: two Adw.EntryRows for what's each just
    // a few characters of HH:MM spent twice the vertical space the values
    // need. A still-running session (no Ended yet anyway) shows its start
    // as plain, read-only text rather than an editable entry - it can still
    // move later (a snap once the session stops, another client's edit), so
    // editing it is only offered once the session has actually stopped.
    _timeRow(session, evidence, draft) {
        let box = new Gtk.Box({
            spacing: 6,
            margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12,
        });
        let running = session.endMs === null;

        box.append(new Gtk.Label({
            label: 'Started', css_classes: ['caption', 'dim-label'], valign: Gtk.Align.CENTER,
        }));
        if (running) {
            box.append(new Gtk.Label({
                label: clockOf(session.startMs), valign: Gtk.Align.CENTER,
            }));
        } else {
            this._timeField(box, session, evidence, draft, 'start');
        }

        if (!running) {
            box.append(new Gtk.Box({ hexpand: true }));
            box.append(new Gtk.Label({
                label: 'Ended', css_classes: ['caption', 'dim-label'], valign: Gtk.Align.CENTER,
            }));
            this._timeField(box, session, evidence, draft, 'end');
        }

        return new Adw.PreferencesRow({ activatable: false, child: box });
    }

    // Appends one editable HH:MM entry (plus, for "start", its Snap
    // buttons) to `box` - the part of _timeRow a running session skips
    // entirely for "start", since it never has an "end" to skip it for.
    //
    // Backed by `draft` (see _draftFor) rather than the session directly:
    // text the user has typed but not yet sent (no Enter or focus-out yet)
    // must survive a refresh the same way the Note field's unsaved text
    // does, since ClockChanged - fired by any field saving itself, "Use
    // actual", or any other client mutating the clock, including from the
    // panel or the Shell's own toggle-clock shortcut, but NOT by the
    // clock's own 30s heartbeat, which never touches onChange at all - can
    // rebuild this row at any time.
    //
    // There is no Save button here: this entry saves itself, on Enter
    // (`activate`) and on losing focus, but only when there's something to
    // send - the field is dirty AND its parsed value actually differs from
    // the session's current one - so tabbing through an untouched field
    // never fires a pointless UpdateSession round trip.
    _timeField(box, session, evidence, draft, which) {
        let draftKey = which === 'start' ? 'start' : 'end';
        let dirtyKey = which === 'start' ? 'startDirty' : 'endDirty';
        let current = which === 'start' ? session.startMs : session.endMs;

        let entry = new Gtk.Entry({ width_chars: 6, valign: Gtk.Align.CENTER });
        // Seeded from the draft, then the dirty-tracking handler is
        // connected - same ordering as _adjustRows's Note/Bill fields, so
        // seeding this text never itself marks the field dirty.
        entry.text = draft[draftKey];
        entry.connect('notify::text', () => {
            draft[draftKey] = entry.text;
            draft[dirtyKey] = true;
        });
        this._registerFocusField(session, which, entry);

        // Returns whether the change landed, so a snap only offers an undo
        // for one that did.
        let apply = ms => {
            let fields = which === 'start' ? { startMs: ms } : { endMs: ms };
            try {
                let [json] = this._proxy.UpdateSessionSync(
                    session.id, JSON.stringify(fields));
                let result = JSON.parse(json);
                if (result.error) {
                    this._toast(describeUpdateError(result.error));
                    return false;
                }
                // Applied: the server's copy is now the truth and the
                // ClockChanged this triggers will rebuild this row, so the
                // draft must stop pinning the text that was just sent -
                // otherwise the next render would show what was typed
                // instead of re-seeding from the session's new value.
                draft[dirtyKey] = false;
                this._toastIfUnsaved(result);
                return true;
            } catch (e) {
                this._toast(`Failed: ${e.message}`);
                return false;
            }
        };

        // An arrow that snaps this time to `target` - `what` names it, e.g.
        // "end of previous session" - with the exact time in its tooltip and
        // an Undo on the toast that confirms it.
        let snap = (icon, target, what) => {
            let button = new Gtk.Button({
                icon_name: icon,
                css_classes: ['flat'],
                valign: Gtk.Align.CENTER,
                tooltip_text: `Snap to ${what} (${clockOf(target)})`,
            });
            button.connect('clicked', () => {
                let before = current;
                if (apply(target))
                    this._toastUndo(`Snapped to ${what}`, () => apply(before));
            });
            return button;
        };
        // Earlier sits before the field and later after it, so each arrow
        // points the way it moves the time.
        let earlier = null;
        let later = null;
        if (which === 'start') {
            let previousEnd = this._previousEndFor(session);
            if (previousEnd !== null && previousEnd < session.startMs) {
                earlier = snap('go-previous-symbolic', previousEnd, 'end of previous session');
            }
            let firstActivity = evidence.firstActivityMs ?? null;
            if (firstActivity !== null && firstActivity > session.startMs) {
                later = snap('go-next-symbolic', firstActivity, 'first activity');
            }
        } else {
            let nextStart = this._nextStartFor(session);
            if (nextStart !== null && nextStart > session.endMs) {
                later = snap('go-next-symbolic', nextStart, 'start of next session');
            }
        }

        let commit = () => {
            if (!draft[dirtyKey])
                return;
            let ms = parseClock(entry.text, current ?? session.startMs);
            if (ms === null) {
                this._toast('Enter a time as HH:MM.');
                return;
            }
            if (ms !== current)
                apply(ms);
        };
        entry.connect('activate', commit);
        let focus = new Gtk.EventControllerFocus();
        focus.connect('leave', commit);
        entry.add_controller(focus);
        if (earlier)
            box.append(earlier);
        box.append(entry);
        if (later)
            box.append(later);
    }

    // The end of the latest session that day that finished at or before
    // this one started, which is what "I forgot to switch" should snap to.
    // The same day only: the first session of a morning must not reach
    // back to last night.
    _previousEndFor(session) {
        let best = null;
        for (let other of this._sessions ?? []) {
            if (other.id === session.id || other.endMs === null || other.dayKey !== session.dayKey)
                continue;
            if (other.endMs <= session.startMs && (best === null || other.endMs > best))
                best = other.endMs;
        }
        return best;
    }

    // The start of the first session that day beginning at or after this
    // one ended, which is where "I forgot to switch" should extend it to.
    _nextStartFor(session) {
        let best = null;
        for (let other of this._sessions ?? []) {
            if (other.id === session.id || other.dayKey !== session.dayKey)
                continue;
            if (other.startMs >= session.endMs && (best === null || other.startMs < best))
                best = other.startMs;
        }
        return best;
    }

    // General, then the client's projects (inactive ones included), plus
    // the session's own project if it has since been deleted, so an old
    // session never silently turns General. null when the client has no
    // projects at all and this session never had one either - nothing to
    // choose between. Saves on change, like "Use actual", since it is a
    // single choice rather than typed text.
    _projectRow(session) {
        // A missing project (a session JSON read during a Shell upgrade,
        // say, saved before this field existed) means General, same as
        // null - resolved once here so it can never become the literal
        // string "undefined" among the choices below.
        let current = session.project ?? null;
        let names = readProjects(this._settings, session.client).map(p => p.name);
        if (current !== null && !names.includes(current))
            names.push(current);
        if (names.length === 0)
            return null;
        let choices = [null, ...names];
        let row = new Adw.ComboRow({
            title: 'Project',
            model: Gtk.StringList.new(choices.map(p => p ?? 'General')),
            selected: choices.indexOf(current),
            // A running session's client/project pairing can still change
            // from the panel while it's on the clock, so this is read-only
            // until it stops - same reasoning as Started/Bill, above.
            sensitive: session.endMs !== null,
        });
        row.connect('notify::selected', () => {
            let chosen = choices[row.selected];
            if (chosen !== current)
                this._updateSession(session, { project: chosen });
        });
        return row;
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
    // rebuilds this row from scratch on every ClockChanged - fired whenever
    // a field saves itself, by "Use actual", and by any other client
    // mutating the clock, but never by the clock's own 30s heartbeat, which
    // does not touch onChange - and an untouched field must track the
    // session, not freeze at its first-render value. A field the user HAS
    // edited (its dirty flag is true) is left alone - that's an in-progress
    // edit, not something to overwrite - and clearing dirty on a successful
    // save is exactly what hands the field back to being re-seeded here.
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
    // last-saved values. Neither has a Save button - each saves itself, on
    // Enter or on losing focus - so the dirty flags below double as the
    // guard against sending the same edit twice.
    //
    // A running session (no endMs yet) gets no Bill row (null): its hours
    // change under you every tick (see _tickLive), so there is nothing
    // sensible to bill until it stops. Its Note is still fully editable -
    // unlike the hours, a note can be written at any time.
    _adjustRows(session, draft) {
        let running = session.endMs === null;

        let noteRow = new Adw.EntryRow({ title: 'Note' });
        // Starts from the session's saved note only, never from the
        // activities above: those are repository names, hostnames and
        // subreddits, not something to put on an invoice.
        noteRow.text = draft.note;
        // Connected after the row is seeded from the draft above, so
        // restoring a draft (or seeding a fresh one) never itself marks
        // anything dirty - only an edit the user makes here does.
        noteRow.connect('notify::text', () => {
            draft.note = noteRow.text;
            draft.noteDirty = true;
        });
        // Saves on Enter (`entry-activated`) and on losing focus, but only
        // when there's an edit to send - re-sending an unchanged, merely
        // revisited note on every tab-through would be a pointless round
        // trip, and a successful _updateSession() call already clears
        // noteDirty, so a second commit right after (Enter, then the focus
        // change Enter itself may cause) finds nothing left to send.
        let saveNote = () => {
            if (!draft.noteDirty)
                return;
            let text = noteRow.text.trim();
            if (text !== session.description)
                this._updateSession(session, { description: text });
        };
        noteRow.connect('entry-activated', saveNote);
        let noteFocus = new Gtk.EventControllerFocus();
        noteFocus.connect('leave', saveNote);
        noteRow.add_controller(noteFocus);
        this._registerFocusField(session, 'note', noteRow);

        // The actual hours are already on the row's title line, so the
        // heading only names the controls. A running session has no Bill
        // row at all: its times tick on the title line.
        let heading = new Gtk.Label({
            label: 'Hours',
            xalign: 0,
            css_classes: ['caption', 'dim-label'],
        });

        let billRow = null;
        if (!running) {
            let hours = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({
                    // 24 would clamp a clock left running over a weekend to
                    // "24.00 h", and a save would then send that ceiling as
                    // billedHours - permanently discarding the true value.
                    lower: 0, upper: 999, step_increment: 0.25, page_increment: 1,
                    value: draft.hours,
                }),
                digits: 2,
                valign: Gtk.Align.CENTER,
            });
            // The Bill control's edits go through HoursBinding, which tells
            // a person's change apart from _tickLive()'s own refresh: GTK
            // fires value-changed for both, and only the first may mark
            // hours edited.
            let binding = new HoursBinding(hours.adjustment, draft);

            // Saves on Enter and on losing focus, only when there's an
            // edit to send - same guard, and the same reason, as the Note
            // field above.
            let saveHours = () => {
                if (!draft.hoursDirty)
                    return;
                this._updateSession(session, { billedHours: Math.round(hours.value * 100) / 100 });
            };
            // The spin button commits typed text on Enter or on losing
            // focus, and its own - and + step without taking focus at all;
            // each ends in value-changed, so that one signal saves them all.
            hours.connect('value-changed', saveHours);
            this._registerFocusField(session, 'hours', hours);

            // Sends billedHours alone (the note is left untouched, since
            // UpdateSession only touches fields present in the payload), so
            // using it never discards an unsaved Note edit. Disabled once
            // the session is already showing its actual time: there is
            // nothing left for it to reset.
            let useActual = new Gtk.Button({
                label: 'Use actual', css_classes: ['flat'],
                sensitive: hasBilledHours(session),
            });
            useActual.connect('clicked', () => this._updateSession(session, { billedHours: null }));

            let controls = new Gtk.Box({ spacing: 6 });
            controls.append(useActual);
            controls.append(hours);
            let round = new Gtk.Button({ label: 'Round up', css_classes: ['flat'] });
            round.connect('clicked', () => {
                // Up to the next quarter hour, never down. The epsilon keeps
                // a value already on a quarter (1.25) from float noise
                // pushing it to the next one.
                // Saved by the spin button's value-changed handler above.
                hours.value = Math.ceil(hours.value * 4 - 1e-9) / 4;
            });
            controls.append(round);
            // Only offered when there is something to round: hidden while
            // the hours already sit on a quarter.
            let syncRound = () => {
                let quarters = hours.value * 4;
                round.visible = Math.abs(quarters - Math.round(quarters)) > 1e-9;
            };
            hours.adjustment.connect('value-changed', syncRound);
            syncRound();

            // Two lines of its own - the heading, then the controls -
            // rather than an ActionRow suffix, which squeezed the title
            // into a sliver beside this many controls. The heading matches
            // the Started, Ended and Note titles.
            let billBox = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 6,
                margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12,
            });
            billBox.append(heading);
            billBox.append(controls);
            billRow = new Adw.PreferencesRow({ activatable: false, child: billBox });
        }

        return [billRow, noteRow];
    }

    // Recomputes every currently-running session's times label locally,
    // every LIVE_TICK_SECONDS, with no D-Bus call at all: actualHoursOf()
    // reads Date.now() fresh on every call, so the figure just needs
    // pushing back into the label already on screen - never a rebuild. A
    // running session has no Bill controls to keep in step (see
    // _adjustRows): it can't sensibly be billed until it stops.
    _tickLive() {
        for (let { session, times } of this._liveRows.values())
            times.label = sessionTimes(session);
    }

    // Shared by every field that saves itself (Note, Bill/hours), by "Use
    // actual" and by the Project dropdown: all send a partial fields
    // payload and report a rejection through a toast. A successful update
    // fires ClockChanged, which rebuilds this row from the server's copy,
    // so only the dirty flag(s) for the field(s) this call actually wrote
    // are cleared here - that hands them back to _draftFor to re-seed from
    // the session on the rebuild. A field this call did NOT touch (an
    // unsaved Note edit sitting in the row while only "Use actual" was
    // clicked, say) is left dirty, with its draft text untouched: clearing
    // every flag here, rather than just the one(s) this call's fields name,
    // would otherwise discard that unrelated unsaved edit - exactly what
    // _drafts exists to prevent. A rejected or failed call leaves every
    // flag as it was, so nothing typed is lost.
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

    _toastUndo(text, onUndo) {
        let toast = new Adw.Toast({ title: text, button_label: 'Undo' });
        toast.connect('button-clicked', onUndo);
        this._toasts.add_toast(toast);
    }

    _showError(text) {
        let group = new Adw.PreferencesGroup();
        group.add(new Adw.ActionRow({ title: text }));
        this._page.add(group);
        this._groups.push(group);
    }
}
