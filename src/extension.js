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
import { isKnownClient } from './clients.js';
import { migratePanelSetting, panelClockState } from './panelMode.js';
import { nudgeDue, awayMomentMs, awayNudgeDue } from './nudge.js';
import { IntervalLog } from './intervalLog.js';
import { LimitNotifier } from './limitNotifier.js';
import { ClockNotifier } from './clockNotifier.js';
import { ActivitySourceRegistry, ZellijSource } from './activitySources.js';
import { BrowserSource } from './browserSource.js';
import { DbusService } from './dbusService.js';
import { ClockDBus } from './clockDBus.js';

// GNOME Shell caches an extension's ES modules for the life of the Shell
// process, so module-scoped state survives a disable()/enable() cycle (a
// lock, an idle blank, a suspend with lock-on-suspend - metadata.json
// declares no session-modes, so GNOME Shell 50 disables this extension on
// all three, verified against ui/extensionSystem.js's
// _extensionSupportsSessionMode() and ui/screenShield.js's activate(),
// which pushes the 'unlock-dialog' session mode) but dies with the process
// itself - a crash, a real logout/login, `make reload` (a fresh dev UUID
// means fresh module state), a reboot. That is exactly the distinction
// ClockStore.recover()'s resumeId needs: non-null here means "the same
// Shell process that was running this session a moment ago", so it is safe
// to resume regardless of the gap; a different process always starts with
// heldSessionId === null, and the ordinary gap rule applies unchanged.
//
// heldSessionId is the running session's id as of the last disable(), or
// null; heldAwaySince mirrors the tracker's own away-since instant at that
// same moment (0 if it had not yet noticed anything away). Both are read
// and cleared at the start of the next enable() - see there.
let heldSessionId = null;
let heldAwaySince = 0;

export default class ScreenTimeExtension extends Extension {
    // GNOME Shell never calls disable() after a throwing enable() (verified
    // against ui/extensionSystem.js's _callExtensionEnable: its catch block
    // only unloads the stylesheet and logs the error, leaving the
    // extension in the ERROR state - disable() is simply never reached),
    // and with C1, enable() now runs on every unlock, not just once at
    // login. A throw partway through after that would leak everything
    // registered before it - notably ClockDBus's D-Bus object export,
    // which makes every later enable() fail with "already exported" until
    // the Shell itself restarts, locking the clock out for the rest of the
    // session. Wrapping the whole body and calling this.disable() ourselves
    // before rethrowing cleans up exactly what got set up; disable() is
    // written to be safe to call on a partially built extension (every
    // field access null-guarded, every timeout/signal id checked before
    // removal) specifically so this is safe at any point the throw occurs.
    enable() {
        try {
            this._settings = this.getSettings();

            this._store = new UsageStore(this._settings);
            this._clock = new ClockStore(this._settings);
            // Built before recover() runs, so a session left open by a crash
            // can actually be reported - nobody opens the Timesheet unprompted,
            // so "surfaced for review" would otherwise never be seen.
            this._notifier = new ClockNotifier(this._clock);

            // Read and cleared immediately, before recover() below mutates
            // anything: a throw partway through enable() (see the try/catch
            // this whole body runs in) must never leave stale module state
            // for a later enable() to misread - the next disable() sets
            // these fresh from whatever is running by then regardless.
            let resumeId = heldSessionId;
            let awaySince = heldAwaySince;
            heldSessionId = null;
            heldAwaySince = 0;
            // Read before recover() runs: recover() refreshes the resumed
            // session's own lastSeenMs to `nowMs`, so this is the last chance
            // to see what it was before that - the away-on-unlock nudge below
            // needs that original value, not the just-refreshed one.
            let heldLastSeenMs = resumeId ? this._clock.sessionById(resumeId)?.lastSeenMs ?? null : null;

            let nowMs = Date.now();
            let interrupted = this._clock.recover(nowMs, { resumeId });
            if (interrupted)
                this._notifier.notifyInterrupted(interrupted);
            // Catches a read-only clock.json discovered at construction
            // (see ClockStore._load()) immediately, rather than leaving it
            // to the first onChange or the first 30s heartbeat tick.
            this._notifier.syncSaveHealth();

            // Surfaces whatever a lock/idle-blank/suspend cost while this
            // extension itself was disabled and could run no timer, no idle
            // watch, nothing - the reachability the idle and suspend nudges
            // lose in exactly that window. Only when a held session was
            // actually resumed: recover() above always resumes it when
            // resumeId names a session that was still open.
            if (resumeId && heldLastSeenMs !== null) {
                let resumed = this._clock.sessionById(resumeId);
                if (resumed && resumed.endMs === null) {
                    let awayMoment = awayMomentMs(awaySince, heldLastSeenMs);
                    let minutes = this._settings.get_int('clock-nudge-minutes');
                    if (awayNudgeDue(awayMoment, nowMs, minutes))
                        this._notifier.notifyAway(resumed, awayMoment, nowMs);
                }
            }

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
                    // An unattended GLib timeout that throws has its source
                    // silently dropped by GJS - the callback just never
                    // runs again, with nothing in the journal to say why.
                    // One bad tick would otherwise permanently stop the
                    // heartbeat, and with it the panel clock, the idle
                    // nudge and save-health monitoring, for the rest of
                    // this Shell session. Always returns SOURCE_CONTINUE,
                    // even when something inside throws.
                    try {
                        this._clock.heartbeat();
                        this._syncPanelClock();
                        this._checkNudge();
                        // heartbeat()'s own save doesn't fire clock.onChange
                        // (see the onChange assignment below), so a save
                        // failure that only ever happens during a heartbeat
                        // tick - nothing else touching the clock in between
                        // - would otherwise never reach syncSaveHealth() at
                        // all. This tick is the backstop; the onChange-
                        // driven call below is the fast path for anything
                        // that mutates the clock directly.
                        this._notifier?.syncSaveHealth();
                    } catch (e) {
                        console.error(`[ScreenTime] heartbeat tick failed: ${e.message}`);
                    }
                    return GLib.SOURCE_CONTINUE;
                });

            migratePanelSetting(this._settings);
            // last-client and the client list decide whether a stopped
            // clock is paused (see panelClockState), so both re-sync it.
            this._settings.connectObject(
                'changed::panel-time', () => this._syncPanelLabel(),
                'changed::last-client', () => this._syncPanelClock(),
                'changed::clients', () => this._syncPanelClock(),
                this);
            this._syncPanelLabel();

            // Must be set before ClockDBus is constructed below - see the
            // comment there.
            this._clock.onChange = () => {
                // Whatever started the running session - a client row, the
                // card, the shortcut, DBus - it is the one pausing leaves
                // resumable. Without this a DBus start after Stop would
                // look stopped, not paused, once paused.
                let running = this._clock?.running;
                if (running && this._settings?.get_string('last-client') !== running.client)
                    this._settings.set_string('last-client', running.client);
                this._syncPanelClock();
                this._notifier?.syncSaveHealth();
            };
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

            // A real logout or full shutdown/reboot does NOT call disable() -
            // only a session-mode change does (a lock, an idle blank, a suspend
            // that locks), and none of those are a genuine end. `global`
            // (Shell.Global) emits 'shutdown' at a real session end: verified
            // against GNOME Shell 50's extracted ui/main.js, which connects to
            // it twice at Shell startup (line ~242, tearing down the input
            // method; line ~266, which blocks the whole shutdown in a nested
            // GLib.MainLoop until an async task - flushing the time-limits
            // history - finishes). That second handler is proof a 'shutdown'
            // listener can reliably still run code before the process actually
            // exits; this one is synchronous (closeForShutdown() just writes
            // clock.json), so no such loop is needed here. ui/sessionMode.js
            // defines only 'restrictive', 'gdm', 'unlock-dialog' and 'user' as
            // session modes, and ui/endSessionDialog.js (the logout/shutdown
            // confirmation dialog) never pushes one, so this extension stays
            // enabled - and this handler stays connected - through the whole
            // confirmation. This is the one chance to close the session cleanly
            // before recover()'s fallback has to: the next login's recover()
            // still closes it at its last heartbeat (at most 30s late) and
            // marks it interrupted if this somehow doesn't fire in time.
            this._shutdownId = global.connect('shutdown', () => {
                this._clock?.closeForShutdown();
                heldSessionId = null;
            });

            // Registered last: if anything above throws, the catch below
            // calls disable() and rethrows, so a grab taken earlier would
            // otherwise stay registered - global and un-removable - until
            // the Shell itself restarts. Registering only once everything
            // else has succeeded means a failed enable() never leaves a
            // dangling keybinding for disable() to clean up in the first
            // place, though it would be harmless either way (see
            // disable()'s call to Main.wm.removeKeybinding()).
            //
            // IGNORE_AUTOREPEAT so holding the keys cannot start and stop
            // repeatedly; NORMAL | OVERVIEW so it works on the desktop and with
            // Activities open.
            Main.wm.addKeybinding(
                'toggle-clock', this._settings,
                Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => this._toggleClock());
        } catch (e) {
            this.disable();
            throw e;
        }
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
    // clients configured, or with last-client naming one since deleted from
    // Preferences, there is nothing to start, so it does nothing.
    _toggleClock() {
        try {
            if (this._clock.running) {
                this._clock.stop();
            } else {
                let last = this._settings.get_string('last-client');
                if (!isKnownClient(this._settings, last))
                    return;
                this._clock.start(last);
            }
        } catch (e) {
            // start()/stop() throw only when the system clock is out of
            // range; the keyboard shortcut has no toast of its own, so log
            // and leave the popup showing whatever actually happened rather
            // than refreshing it into a state that implies success.
            console.error(`[ScreenTime] toggle-clock failed: ${e.message}`);
            return;
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
            this._tracker?.away ?? false,
            isKnownClient(this._settings, this._settings.get_string('last-client'))));
    }

    // Must be safe to call at any point enable() might have thrown (see the
    // try/catch there) - on a fully built extension, a completely untouched
    // one (getSettings() itself threw), or anything in between. Every field
    // is therefore accessed through `?.` or an `if` guard, and every
    // timeout/signal id is checked before removal.
    disable() {
        this._settings?.disconnectObject(this);
        if (this._heartbeatId) {
            GLib.source_remove(this._heartbeatId);
            this._heartbeatId = null;
        }
        // Disconnected before anything the callback reaches (this._clock,
        // this._notifier) is torn down below, so a suspend signal arriving
        // mid-teardown can never fire into a half-destroyed extension.
        if (this._sleepId) {
            this._loginManager?.disconnect(this._sleepId);
            this._sleepId = null;
        }
        this._loginManager = null;
        // Same reasoning as the suspend listener above: gone before
        // this._clock is torn down, so a 'shutdown' arriving mid-teardown
        // (unlikely, but not impossible if disable() itself runs as part of
        // logout for some other reason) can never fire into a half-
        // destroyed extension.
        if (this._shutdownId) {
            global.disconnect(this._shutdownId);
            this._shutdownId = null;
        }
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
        // now: release() below doesn't fire onChange itself (it saves via
        // heartbeat(), not _changed()), but leaving a stale handler
        // pointed at a half-destroyed extension is exactly the kind of
        // ordering hazard this file guards against everywhere else.
        if (this._clock)
            this._clock.onChange = null;
        // Destroyed before the clock: destroying a resident notification's
        // actions (Stop/Trim sleep, Stop/Trim away time) call into
        // this._clock, so the notifier - and the buttons a user could
        // still click - must be gone before this._clock is released below.
        this._notifier?.destroy();
        this._notifier = null;
        this._popup?.destroy();
        this._popup = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._limitNotifier = null;
        this._intervals?.destroy();
        this._intervals = null;
        // Safe even when enable() never reached addKeybinding(): Shell 50's
        // WindowManager.removeKeybinding() (ui/windowManager.js) just checks
        // global.display.remove_keybinding()'s boolean return and skips
        // silently when there was nothing to remove - it never throws.
        Main.wm.removeKeybinding('toggle-clock');
        // release(), not destroy(): the clock keeps running through a lock,
        // an idle blank and a suspend (all of which disable this extension
        // - see the module-scoped heldSessionId comment at the top of this
        // file), so disable() must never close the running session, only
        // refresh its heartbeat and remember it for the next enable().
        // heldAwaySince mirrors this._awaySince (0 if the tracker had not
        // yet noticed anything away by now) for the away-on-unlock nudge.
        if (this._clock) {
            heldSessionId = this._clock.release(Date.now());
            if (this._awaySince > 0)
                heldAwaySince = this._awaySince;
        }
        this._clock = null;
        this._store?.destroy();
        this._store = null;
        this._settings = null;
    }
}
