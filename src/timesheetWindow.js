import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

// The Timesheet is a separate process from the Shell, so its D-Bus proxy is
// built from the same XML the Shell exports rather than a pasted second
// copy: a method added to ClockDBus then exists on both sides by
// construction, instead of silently drifting out of sync here.
import { INTERFACE_XML } from './clockDBus.js';

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
function formatHours(h) {
    if (h >= 1)
        return `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;
    return `${Math.round(h * 60)}m`;
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
        let toolbar = new Adw.ToolbarView({ content: this._page });
        toolbar.add_top_bar(new Adw.HeaderBar());
        // Every rejection path in this window reports through a toast, so the
        // overlay belongs to the window rather than to a later feature.
        this._toasts = new Adw.ToastOverlay({ child: toolbar });
        this.window.content = this._toasts;

        this._groups = [];
        this._refreshing = false;
        this._refreshPending = false;
        if (proxyError) {
            this._showError(`Could not reach the extension: ${proxyError.message}`);
            return;
        }
        this._proxy.connectSignal('ClockChanged', () => this.refresh());
        this.refresh();
    }

    // Everything the Shell holds for the last 30 days. The Shell is the only
    // writer, so this process never reads a file.
    //
    // ClockChanged fires on every Save and Reset now, and this method makes
    // a blocking call in the middle of rebuilding _groups; a second,
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
            if (!row.expanded || loaded)
                return;
            loaded = true;
            this._fillEvidence(row, session);
        });
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

        for (let adjustRow of this._adjustRows(session, evidence))
            row.add_row(adjustRow);
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

    // Returns the Bill row and the Note row together, so the caller adds
    // both without either method reaching into the other's state.
    _adjustRows(session, evidence) {
        let noteRow = new Adw.EntryRow({ title: 'Note' });
        // Seeded from the top activities, never auto-filled onto an
        // invoice: those strings are repository names, hostnames and
        // subreddits. The person billing edits this before it means
        // anything; nothing here is saved until they press Save.
        noteRow.text = session.description.length > 0
            ? session.description
            : evidence.entries.slice(0, 2).map(e => e.displayName).join('; ');

        let hours = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 24, step_increment: 0.25, page_increment: 1,
                value: hoursOf(session),
            }),
            digits: 2,
            valign: Gtk.Align.CENTER,
        });

        let box = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
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
        save.connect('clicked', () => this._updateSession(session, {
            billedHours: Math.round(hours.value * 100) / 100,
            description: noteRow.text,
        }));
        box.append(save);

        // The only way back to "bill the actual time" once an adjustment is
        // set: Save alone can approximate that by re-typing the actual
        // hours, but never undo the adjustment itself. Sends billedHours
        // alone - the note is left untouched, since UpdateSession only
        // touches fields present in the payload.
        let reset = new Gtk.Button({ label: 'Reset', css_classes: ['flat'] });
        reset.connect('clicked', () => this._updateSession(session, { billedHours: null }));
        box.append(reset);

        let hoursRow = new Adw.ActionRow({
            title: 'Bill',
            subtitle: `${(evidence.spanSeconds / 3600).toFixed(2)} h on the clock`,
        });
        hoursRow.add_suffix(box);

        return [hoursRow, noteRow];
    }

    // Shared by Save and Reset: both send a partial fields payload and
    // report a rejection through a toast. A successful update fires
    // ClockChanged, which refreshes the whole list, so there is nothing
    // else to do here on success.
    _updateSession(session, fields) {
        try {
            let [json] = this._proxy.UpdateSessionSync(session.id, JSON.stringify(fields));
            let result = JSON.parse(json);
            if (result.error)
                this._toast(describeUpdateError(result.error));
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
