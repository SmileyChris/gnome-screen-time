import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import { PanelIndicator } from './panelIndicator.js';
import { PopupWidget } from './popupWidget.js';
import { UsageTracker } from './usageTracker.js';
import { UsageStore, todayKeyFor } from './usageStore.js';
import { ClockStore } from './clockStore.js';
import { migratePanelSetting, panelClockState } from './panelMode.js';
import { nudgeDue } from './nudge.js';
import { IntervalLog } from './intervalLog.js';
import { LimitNotifier } from './limitNotifier.js';
import { ClockNotifier } from './clockNotifier.js';
import { ActivitySourceRegistry, ZellijSource } from './activitySources.js';
import { BrowserSource } from './browserSource.js';
import { DbusService } from './dbusService.js';
import { ClockDBus } from './clockDBus.js';

export default class ScreenTimeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._store = new UsageStore(this._settings);
        this._clock = new ClockStore(this._settings);
        // Built before recover() runs, so a session left open by a crash
        // can actually be reported - nobody opens the Timesheet unprompted,
        // so "surfaced for review" would otherwise never be seen.
        this._notifier = new ClockNotifier(this._clock, this._settings);
        let interrupted = this._clock.recover();
        if (interrupted)
            this._notifier.notifyInterrupted(interrupted);

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
                this._checkNudge();
                return GLib.SOURCE_CONTINUE;
            });

        migratePanelSetting(this._settings);
        this._settings.connectObject(
            'changed::panel-time', () => this._syncPanelLabel(), this);
        this._syncPanelLabel();

        // Must be set before ClockDBus is constructed below - see the
        // comment there.
        this._clock.onChange = () => this._syncPanelClock();
        // 0 while not away; the instant UsageTracker first reported away,
        // otherwise. `_onPrepareForSleep(true)` calls `_setAway(true)` even
        // when the lock screen already made the tracker away, so onAway(true)
        // can arrive twice in a row with no `false` between - only setting
        // this when it is still 0 keeps a second such call from restarting
        // the timer and pushing the nudge out by a whole threshold.
        this._awaySince = 0;
        this._nudgedAt = 0;
        this._tracker.onAway = away => {
            this._syncPanelClock();
            if (away) {
                if (this._awaySince === 0)
                    this._awaySince = Date.now();
            } else if (this._awaySince > 0) {
                this._awaySince = 0;
                this._nudgedAt = 0;
            }
        };
        this._syncPanelClock();

        // ClockDBus wraps clock.onChange, chaining through whatever handler
        // is already there. Any code that wants to set clock.onChange
        // itself must do so BEFORE this line: an assignment after this
        // point silently replaces ClockDBus's wrapper, and ClockChanged
        // stops firing over D-Bus with no error anywhere.
        this._clockDbus = new ClockDBus(this._clock, this._intervals, this._settings);

        // A second, independent prepare-for-sleep listener alongside
        // UsageTracker's own (src/usageTracker.js:_onPrepareForSleep):
        // reaching into the tracker's connection would couple this to its
        // internals, so this mirrors its exact connect/disconnect pattern
        // instead - plain connect()/disconnect(), not connectObject(), since
        // nothing here guarantees LoginManager's object supports that.
        this._loginManager = LoginManager.getLoginManager();
        this._sleptAt = 0;
        this._sleepId = this._loginManager.connect(
            'prepare-for-sleep', (lm, aboutToSuspend) => {
                if (aboutToSuspend) {
                    this._sleptAt = Date.now();
                    return;
                }
                // A `false` with no preceding `true` (a listener installed
                // mid-suspend somehow) must not be treated as a real sleep.
                if (this._sleptAt === 0)
                    return;
                let wokeAt = Date.now();
                let sleptAt = this._sleptAt;
                this._sleptAt = 0;
                let session = this._clock.running;
                let slept = (wokeAt - sleptAt) / 1000;
                let minutes = this._settings.get_int('clock-nudge-minutes');
                if (session && minutes > 0 && slept >= minutes * 60)
                    this._notifier?.notifyResume(session, Math.round(slept), sleptAt, wokeAt);
            });

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

    // Fires once per idle spell, then hourly, by updating the same
    // notification rather than stacking new ones - nudgeDue (src/nudge.js)
    // holds the actual timing rule so it can be tested without the Shell.
    _checkNudge() {
        let session = this._clock.running;
        if (!session)
            return;
        let minutes = this._settings.get_int('clock-nudge-minutes');
        let now = Date.now();
        if (!nudgeDue(this._awaySince, this._nudgedAt, now, minutes))
            return;
        this._nudgedAt = now;
        this._notifier.notifyIdle(
            session, Math.round((now - this._awaySince) / 1000), this._awaySince);
    }

    // this._clock.onChange can still fire after this._indicator is gone -
    // see the comment in disable() on why that assignment is cleared there,
    // but guard here too, matching every other disable()-ordering hazard in
    // this file.
    _syncPanelClock() {
        if (!this._indicator)
            return;
        this._indicator.setClock(panelClockState(
            this._clock, todayKeyFor(this._settings), Date.now(),
            this._tracker?.away ?? false));
    }

    disable() {
        this._settings.disconnectObject(this);
        if (this._heartbeatId) {
            GLib.source_remove(this._heartbeatId);
            this._heartbeatId = null;
        }
        // Disconnected before anything the callback reaches (this._clock,
        // this._notifier) is torn down below, so a suspend signal arriving
        // mid-teardown can never fire into a half-destroyed extension.
        if (this._sleepId) {
            this._loginManager.disconnect(this._sleepId);
            this._sleepId = null;
        }
        this._loginManager = null;
        this._tracker?.destroy();      // destroys the registry and its sources
        this._tracker = null;
        this._dbus?.destroy();
        this._dbus = null;
        this._clockDbus?.destroy();
        this._clockDbus = null;
        // ClockDBus.destroy() just restored clock.onChange to the
        // _syncPanelClock closure enable() put there (it chains through
        // whatever handler it finds at construction and restores exactly
        // that on destroy). Everything that closure reaches - indicator,
        // tracker, settings - is about to be torn down below, so clear it
        // now: otherwise this._clock.destroy() below fires onChange one
        // last time into a half-destroyed extension (this._indicator is
        // already null by then), which throws and aborts both the rest of
        // ClockStore.destroy() and the rest of disable() - leaking
        // UsageStore's autosave timer and settings handlers on every
        // logout/reload while a client is clocked in.
        if (this._clock)
            this._clock.onChange = null;
        // Destroyed before the clock: destroying a resident notification's
        // actions (Stop/Trim sleep) call into this._clock, so the notifier
        // - and the buttons a user could still click - must be gone before
        // ClockStore.destroy() below closes the running session and fires
        // its own callbacks into an extension that is already half torn
        // down.
        this._notifier?.destroy();
        this._notifier = null;
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
