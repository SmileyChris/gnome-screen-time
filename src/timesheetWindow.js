import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

// The Timesheet is a separate process from the Shell, so its D-Bus proxy is
// built from the same XML the Shell exports rather than a pasted second
// copy: a method added to ClockDBus then exists on both sides by
// construction, instead of silently drifting out of sync here.
import { INTERFACE_XML } from './clockDBus.js';
// parseClock lives in its own portable module (GLib only, no Adw/Gtk) so it
// can be unit-tested directly rather than only ever exercised through this
// GTK-dependent window.
import { parseClock } from './clockTime.js';

const ClockProxy = Gio.DBusProxy.makeProxyWrapper(INTERFACE_XML);

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
        // _expandedIds carries which rows should come back open.
        this._drafts = new Map();
        this._expandedIds = new Set();
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
            let format = path.endsWith('.csv') ? 'csv' : 'json';
            try {
                let [json] = this._proxy.ExportPeriodSync(
                    fromDayKey, toDayKeyExclusive, path, format);
                let result2 = JSON.parse(json);
                this._toast(result2.error
                    ? `Export failed: ${describeExportError(result2.error)}`
                    : `Exported ${result2.rows} row(s) to ${path}`);
            } catch (e) {
                this._toast(`Export failed: ${e.message}`);
            }
        });
    }

    // Everything the Shell holds for the last 30 days. The Shell is the only
    // writer, so this process never reads a file.
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

            let to = Date.now();
            let from = to - 30 * 24 * 3600 * 1000;
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
                let billed = daySessions.reduce((sum, s) => sum + hoursOf(s), 0);
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

    _sessionRow(session) {
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
            subtitle += '   · stopped at logout';
        if (session.exportedAt)
            subtitle += '   · exported';

        let row = new Adw.ExpanderRow({
            title: session.client,
            subtitle,
            css_classes: session.exportedAt ? ['dim-label'] : [],
        });
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
        if (evidence.error) {
            row.add_row(new Adw.ActionRow({ title: 'This session is no longer available.' }));
            return;
        }

        for (let entry of evidence.entries)
            row.add_row(this._entryRow(entry));

        if (evidence.unattributedSeconds > 0) {
            let unattributed = new Adw.ActionRow({
                title: 'Unattributed',
                subtitle: 'No focused window, or away. Undercounts a walk-away by up to one idle timeout.',
                css_classes: ['dim-label'],
            });
            unattributed.add_suffix(new Gtk.Label({
                label: formatHours(evidence.unattributedSeconds / 3600),
            }));
            row.add_row(unattributed);
        }

        // One draft per session backs the Started/Ended fields below and
        // the Note/Bill fields in _adjustRows, so all five widgets agree on
        // what the user has and hasn't touched yet.
        let draft = this._draftFor(session, evidence);

        row.add_row(this._timeRow(session, evidence, draft, 'start'));
        if (session.endMs !== null)
            row.add_row(this._timeRow(session, evidence, draft, 'end'));

        for (let adjustRow of this._adjustRows(session, evidence, draft))
            row.add_row(adjustRow);
    }

    // Epoch ms -> "HH:MM" and back, resolved against the session's own day so
    // typing 09:15 cannot silently move the session to today.
    //
    // Backed by `draft` (see _draftFor) rather than the session directly:
    // text the user has typed but not yet applied (no Enter pressed yet)
    // must survive a refresh the same way the Note field's unsaved text
    // does, since ClockChanged - now also fired by the periodic heartbeat -
    // can rebuild this row at any time.
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

    // One line per app, with its activities nested below it.
    _entryRow(entry) {
        let children = entry.children ? Object.entries(entry.children) : [];
        if (children.length === 0) {
            let leaf = new Adw.ActionRow({ title: entry.displayName });
            leaf.add_suffix(new Gtk.Label({ label: formatHours(entry.seconds / 3600) }));
            return leaf;
        }
        let branch = new Adw.ExpanderRow({ title: entry.displayName });
        branch.add_suffix(new Gtk.Label({ label: formatHours(entry.seconds / 3600) }));
        children
            .sort((a, b) => b[1].seconds - a[1].seconds)
            .forEach(([, node]) => branch.add_row(this._entryRow({
                displayName: node.displayName,
                seconds: node.seconds,
                children: node.children ?? null,
            })));
        return branch;
    }

    // Gets or creates the draft for `session` (this._drafts, keyed by
    // session id) and re-seeds every field the user has NOT touched from
    // the session's current data, before returning it.
    //
    // A draft is created empty on a row's first expansion and would
    // otherwise keep whatever it was first seeded with forever: refresh()
    // rebuilds this row from scratch on every ClockChanged - which now
    // fires on every Save, "Use actual", and a periodic heartbeat tick
    // anywhere in the window - and an untouched field must track the
    // session, not freeze at its first-render value. Left unfixed, this
    // mis-bills a running session: expand it at 1.0 h, leave the row open
    // while the clock runs to 2.0 h, press +1/4, and a frozen draft sends
    // 1.25 instead of 2.25. A field the user HAS edited (its dirty flag is
    // true) is left alone - that's an in-progress edit, not something to
    // overwrite - and clearing dirty on a successful save is exactly what
    // hands the field back to being re-seeded here.
    _draftFor(session, evidence) {
        let seededNote = session.description.length > 0
            ? session.description
            : evidence.entries.slice(0, 2).map(e => e.displayName).join('; ');
        let draft = this._drafts.get(session.id);
        if (!draft) {
            draft = {
                note: '', hours: 0, noteDirty: false, hoursDirty: false,
                start: '', startDirty: false, end: '', endDirty: false,
            };
            this._drafts.set(session.id, draft);
        }
        if (!draft.noteDirty)
            draft.note = seededNote;
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
    _adjustRows(session, evidence, draft) {
        let noteRow = new Adw.EntryRow({ title: 'Note' });
        // Seeded from the top activities, never auto-filled onto an
        // invoice: those strings are repository names, hostnames and
        // subreddits. The seed only reaches Save's payload if the user
        // actually edits this field - see noteDirty below.
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
        hours.connect('value-changed', () => {
            draft.hours = hours.value;
            draft.hoursDirty = true;
        });

        // Renamed from "Reset" and moved away from Save: it sends
        // billedHours alone (the note is left untouched, since
        // UpdateSession only touches fields present in the payload), so a
        // misclick next to Save no longer discards an adjustment with no
        // way back.
        let useActual = new Gtk.Button({ label: 'Use actual', css_classes: ['flat'] });
        useActual.connect('clicked', () => this._updateSession(session, { billedHours: null }));

        let box = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
        box.append(useActual);
        box.append(hours);
        for (let [label, delta] of [['¼', 0.25], ['½', 0.5], ['+1', 1]]) {
            let button = new Gtk.Button({ label, css_classes: ['flat'] });
            button.connect('clicked', () => { hours.value += delta; });
            box.append(button);
        }
        let round = new Gtk.Button({ label: 'Round', css_classes: ['flat'] });
        round.connect('clicked', () => {
            hours.value = Math.round(hours.value * 4) / 4;
        });
        box.append(round);

        let save = new Gtk.Button({ label: 'Save', css_classes: ['suggested-action'] });
        save.connect('clicked', () => {
            if (!draft.hoursDirty && !draft.noteDirty) {
                this._toast('Nothing to save.');
                return;
            }
            // Send only what was actually edited: an hours-only edit must
            // not re-pin the note to its unedited seed (repository names,
            // hostnames, subreddits reaching an invoice), and a note-only
            // edit (fixing a typo) must not pin billedHours to a snapshot
            // that stops following later start/end edits.
            let fields = {};
            if (draft.hoursDirty)
                fields.billedHours = Math.round(hours.value * 100) / 100;
            if (draft.noteDirty)
                fields.description = noteRow.text.trim();
            this._updateSession(session, fields);
        });
        box.append(save);

        let hoursRow = new Adw.ActionRow({
            title: 'Bill',
            subtitle: `${(evidence.spanSeconds / 3600).toFixed(2)} h on the clock`,
        });
        hoursRow.add_suffix(box);

        return [hoursRow, noteRow];
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
        } catch (e) {
            this._toast(`Failed: ${e.message}`);
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
