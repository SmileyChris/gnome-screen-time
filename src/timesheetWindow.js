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

GLib.set_prgname('screen-time-timesheet');

function hoursOf(session) {
    if (session.billedHours !== null && session.billedHours !== undefined)
        return session.billedHours;
    return ((session.endMs ?? Date.now()) - session.startMs) / 3600000;
}

function actualHoursOf(session) {
    return ((session.endMs ?? Date.now()) - session.startMs) / 3600000;
}

function clockOf(ms) {
    return GLib.DateTime.new_from_unix_local(ms / 1000).format('%H:%M');
}

export class TimesheetWindow {
    constructor(app) {
        this._proxy = new ClockProxy(
            Gio.DBus.session, 'org.gnome.Shell',
            '/org/gnome/Shell/Extensions/ScreenTime/Clock');

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
        this._proxy.connectSignal('ClockChanged', () => this.refresh());
        this.refresh();
    }

    // Everything the Shell holds for the last 30 days. The Shell is the only
    // writer, so this process never reads a file.
    refresh() {
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
    }

    _sessionRow(session) {
        let end = session.endMs === null ? 'now' : clockOf(session.endMs);
        let actual = actualHoursOf(session);
        let billed = hoursOf(session);
        let subtitle = `${clockOf(session.startMs)}–${end}`;
        if (session.billedHours !== null && session.billedHours !== undefined)
            subtitle += `   ${billed.toFixed(2)} h  ←  ${actual.toFixed(2)} h`;
        else
            subtitle += `   ${actual.toFixed(2)} h`;
        if (session.interrupted)
            subtitle += '   · interrupted';
        else if (session.cleanStop)
            subtitle += '   · stopped at logout';
        if (session.exportedAt)
            subtitle += '   · exported';

        let row = new Adw.ActionRow({
            title: session.client,
            subtitle,
            css_classes: session.exportedAt ? ['dim-label'] : [],
        });
        if (session.description.length > 0)
            row.add_suffix(new Gtk.Label({ label: session.description, css_classes: ['dim-label'] }));
        return row;
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
