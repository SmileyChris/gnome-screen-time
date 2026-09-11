import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { PanelIndicator } from './panelIndicator.js';
import { PopupWidget } from './popupWidget.js';
import { UsageTracker } from './usageTracker.js';
import { UsageStore } from './usageStore.js';
import { ClockStore } from './clockStore.js';
import { IntervalLog } from './intervalLog.js';
import { LimitNotifier } from './limitNotifier.js';
import { ActivitySourceRegistry, ZellijSource } from './activitySources.js';
import { BrowserSource } from './browserSource.js';
import { DbusService } from './dbusService.js';

export default class ScreenTimeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._store = new UsageStore(this._settings);
        this._clock = new ClockStore(this._settings);
        this._clock.recover();

        // IGNORE_AUTOREPEAT so holding the keys cannot start and stop
        // repeatedly; NORMAL | OVERVIEW so it works on the desktop and with
        // Activities open.
        Main.wm.addKeybinding(
            'toggle-clock', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._toggleClock());

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
            () => { this._clock.heartbeat(); return GLib.SOURCE_CONTINUE; });

        this._settings.connectObject(
            'changed::show-total-in-panel', () => this._syncPanelLabel(), this);
        this._syncPanelLabel();
    }

    _openTimesheet() {
        console.log('[ScreenTime] timesheet window not implemented yet');
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
        this._indicator.setShowTotal(
            this._settings.get_boolean('show-total-in-panel'));
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
