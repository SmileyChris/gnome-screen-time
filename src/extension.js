import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { PanelIndicator } from './panelIndicator.js';
import { PopupWidget } from './popupWidget.js';
import { UsageTracker } from './usageTracker.js';
import { UsageStore, todayKeyFor } from './usageStore.js';
import { ClockStore } from './clockStore.js';
import { migratePanelSetting } from './panelMode.js';
import { IntervalLog } from './intervalLog.js';
import { LimitNotifier } from './limitNotifier.js';
import { ActivitySourceRegistry, ZellijSource } from './activitySources.js';
import { BrowserSource } from './browserSource.js';
import { DbusService } from './dbusService.js';
import { ClockDBus } from './clockDBus.js';

export default class ScreenTimeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._store = new UsageStore(this._settings);
        this._clock = new ClockStore(this._settings);
        this._clock.recover();

        this._indicator = new PanelIndicator();
        this._indicator.addToPanel(this.uuid);
        this._popup = new PopupWidget(this._indicator.menu, this._store,
            this._settings, () => this._openPrefs(), this._clock,
            () => this._openTimesheet());

        // The browser companion pushes into this source over D-Bus; the same
        // instance sits in the registry the tracker reads from.
        let browserSource = new BrowserSource();
        this._dbus = new DbusService(browserSource);
        this._tracker = new UsageTracker(this._store, this._settings,
            new ActivitySourceRegistry([new ZellijSource(), browserSource]));
        this._intervals = new IntervalLog(this._settings);
        this._intervals.purge();
        this._tracker.onInterval = (s, e, path, names) => {
            this._intervals.record(s, e, path, names);
            this._intervals.flush();
        };
        this._limitNotifier = new LimitNotifier(this._settings);

        this._store.onChange = (appId, displayName, seconds) => {
            this._indicator.setTotal(this._store.getTodayTotal());
            if (appId)
                this._limitNotifier.checkLimit(appId, displayName, seconds);
        };
        this._indicator.setTotal(this._store.getTodayTotal());

        this._heartbeatId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 30,
            () => {
                this._clock.heartbeat();
                this._syncPanelClock();
                return GLib.SOURCE_CONTINUE;
            });

        migratePanelSetting(this._settings);
        this._settings.connectObject(
            'changed::panel-time', () => this._syncPanelLabel(), this);
        this._syncPanelLabel();

        // Must be set before ClockDBus is constructed below - see the
        // comment there.
        this._clock.onChange = () => this._syncPanelClock();
        this._tracker.onAway = () => this._syncPanelClock();
        this._syncPanelClock();

        // ClockDBus wraps clock.onChange, chaining through whatever handler
        // is already there. Any code that wants to set clock.onChange
        // itself must do so BEFORE this line: an assignment after this
        // point silently replaces ClockDBus's wrapper, and ClockChanged
        // stops firing over D-Bus with no error anywhere.
        this._clockDbus = new ClockDBus(this._clock, this._intervals, this._settings);

        // Registered last: if anything above throws, enable() aborts and the
        // extension is left in the ERROR state without disable() ever
        // running, so a grab taken earlier would stay registered - global
        // and un-removable - until the Shell itself restarts. Registering
        // only once everything else has succeeded means a failed enable()
        // never leaves a dangling keybinding behind.
        //
        // IGNORE_AUTOREPEAT so holding the keys cannot start and stop
        // repeatedly; NORMAL | OVERVIEW so it works on the desktop and with
        // Activities open.
        Main.wm.addKeybinding(
            'toggle-clock', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggleClock());
    }

    // /usr/bin/gjs rather than bare `gjs`: a systemd user session's PATH is
    // frequently minimal, which is the same trap the zellij lookup hits.
    // Never wait() on this subprocess: it would block the compositor.
    _openTimesheet() {
        try {
            Gio.Subprocess.new(
                ['/usr/bin/gjs', '-m', GLib.build_filenamev([this.path, 'timesheet.js'])],
                Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error(`[ScreenTime] could not launch the timesheet: ${e.message}`);
        }
    }

    // Stops if running; otherwise starts the last client used. With no
    // clients configured there is nothing to start, so it does nothing.
    _toggleClock() {
        if (this._clock.running) {
            this._clock.stop();
        } else {
            let last = this._settings.get_string('last-client');
            if (last.length === 0)
                return;
            this._clock.start(last);
        }
        this._popup?.refresh();
    }

    // The Shell refuses a second preferences dialog while one is showing, so
    // if the prefs process already has a window up, raise that instead.
    _openPrefs() {
        let existing = global.get_window_actors()
            .map(actor => actor.meta_window)
            .find(w => w && (w.get_gtk_application_id?.() === 'org.gnome.Shell.Extensions' ||
                             w.get_wm_class() === 'org.gnome.Shell.Extensions'));
        if (existing) {
            existing.activate(global.get_current_time());
            return;
        }
        this.openPreferences();
    }

    _syncPanelLabel() {
        this._indicator.setMode(this._settings.get_string('panel-time'));
    }

    _syncPanelClock() {
        let running = this._clock.running;
        this._indicator.setClock({
            running: running !== null,
            away: this._tracker?.away ?? false,
            client: running?.client ?? '',
            seconds: this._clock.billedSecondsForDay(todayKeyFor(this._settings)),
        });
    }

    disable() {
        this._settings.disconnectObject(this);
        if (this._heartbeatId) {
            GLib.source_remove(this._heartbeatId);
            this._heartbeatId = null;
        }
        this._tracker?.destroy();      // destroys the registry and its sources
        this._tracker = null;
        this._dbus?.destroy();
        this._dbus = null;
        this._clockDbus?.destroy();
        this._clockDbus = null;
        this._popup?.destroy();
        this._popup = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._limitNotifier = null;
        this._intervals?.destroy();
        this._intervals = null;
        Main.wm.removeKeybinding('toggle-clock');
        this._clock?.destroy();
        this._clock = null;
        this._store?.destroy();
        this._store = null;
        this._settings = null;
    }
}
