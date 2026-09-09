import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as LoginManager from 'resource:///org/gnome/shell/misc/loginManager.js';
import { ActivitySourceRegistry } from './activitySources.js';

// Periodic flush so a long unbroken session still updates the total/limit
// checks without a focus change. Matches UsageStore's autosave cadence.
const FLUSH_INTERVAL = 30;
// org.gnome.SessionManager inhibit flag for idle (GSM_INHIBITOR_FLAG_IDLE).
const IDLE_INHIBIT_FLAG = 8;
// While idle but inhibited, ask again this often.
const IDLE_RECHECK_SECONDS = 60;

// Nothing outside the compositor can read a window title here, so the only
// way to see what a real desktop resolves to is a log line:
//   journalctl -f -o cat /usr/bin/gnome-shell | grep ScreenTime
const DEBUG = GLib.getenv('GNOME_SHELL_EXTENSION_SCREEN_TIME_DEBUG') !== null;

export class UsageTracker {
    constructor(store, settings, sources = new ActivitySourceRegistry()) {
        this._store = store;
        this._settings = settings;
        this._sources = sources;
        this._lastTime = Date.now();

        // Where time is being credited right now: [appId], [appId, activityId]
        // or [appId, activityId, detailId], with matching display names. Null
        // while nothing is focused or the user is away.
        this._path = null;
        this._names = null;
        this._win = null;
        // Bumped whenever the focused window or presence changes, so a
        // resolve that started against an older state is dropped on return.
        this._resolveSeq = 0;

        // A push source (browser companion) changed state. Re-credit only
        // when that source is the one describing the focused window;
        // otherwise a tab change in an unfocused browser would re-resolve a
        // focused terminal and spawn zellij on every report.
        this._sources.onChange = source => {
            if (this._path && source.claims(this._path[0]))
                this._refresh();
        };

        // screenShield only exists when GNOME can lock at all (GDM + systemd),
        // so presence detection treats it as optional; max-interval is the backstop.
        this._shield = Main.screenShield ?? null;
        // Set by the idle monitor after `idle-timeout` seconds without input,
        // cleared on the next input. Covers the case the shield never sees: a
        // screen kept awake by a window while nobody is at the keyboard.
        this._idle = false;
        this._idleMonitor = global.backend.get_core_idle_monitor();
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._idleRecheckId = 0;
        this._away = this._computeAway();

        this._focusId = global.display.connect(
            'notify::focus-window',
            this._onFocus.bind(this)
        );
        if (this._shield) {
            this._activeId = this._shield.connect(
                'active-changed', this._onPresenceChanged.bind(this));
            this._lockedId = this._shield.connect(
                'locked-changed', this._onPresenceChanged.bind(this));
        } else {
            console.debug('[ScreenTime] no screenShield available; ' +
                'relying on suspend detection and max-interval');
        }

        // Always returns an emitter (a no-op dummy without systemd), so this is safe.
        this._loginManager = LoginManager.getLoginManager();
        this._sleepId = this._loginManager.connect(
            'prepare-for-sleep',
            (lm, aboutToSuspend) => this._onPrepareForSleep(aboutToSuspend));

        this._flushId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, FLUSH_INTERVAL,
            () => this._onFlushTick()
        );

        this._armIdleWatch();
        this._idleSettingId = this._settings.connect(
            'changed::idle-timeout', () => this._armIdleWatch());
    }

    // (Re)installs the idle watch for the configured timeout. A timeout of 0
    // disables idle detection. Called at start and whenever the setting changes.
    _armIdleWatch() {
        this._clearIdleWatches();
        let seconds = this._settings.get_int('idle-timeout');
        if (seconds <= 0) {
            if (this._idle) {
                this._idle = false;
                this._onPresenceChanged();
            }
            return;
        }
        this._idleWatchId = this._idleMonitor.add_idle_watch(seconds * 1000,
            () => this._onIdle());
    }

    _clearIdleWatches() {
        if (this._idleWatchId) {
            this._idleMonitor.remove_watch(this._idleWatchId);
            this._idleWatchId = 0;
        }
        if (this._activeWatchId) {
            this._idleMonitor.remove_watch(this._activeWatchId);
            this._activeWatchId = 0;
        }
        this._clearIdleRecheck();
    }

    // No input for the whole timeout. The idle watch keeps firing on every
    // later idle period, so it stays installed; the active watch is one-shot
    // and is armed here to catch the return.
    // No input for the whole timeout. If something inhibits idle (a video,
    // a presentation: the same inhibitors that stop the screensaver), the
    // user is presumably still watching, so keep counting and look again in
    // a minute. Otherwise go away until the next input.
    _onIdle() {
        if (this._idle)
            return;
        this._armActiveWatch();
        this._checkIdleInhibited();
    }

    _checkIdleInhibited() {
        this._idleRecheckId = 0;
        Gio.DBus.session.call(
            'org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', 'IsInhibited',
            new GLib.Variant('(u)', [IDLE_INHIBIT_FLAG]), null,
            Gio.DBusCallFlags.NONE, 2000, null,
            (conn, res) => {
                let inhibited = false;
                try {
                    [inhibited] = conn.call_finish(res).deepUnpack();
                } catch (e) {
                    // No session manager to ask: fall back to plain idleness.
                }
                // The user came back while we were asking.
                if (!this._activeWatchId)
                    return;
                if (inhibited) {
                    if (DEBUG)
                        console.log('[ScreenTime] idle, but idle is inhibited; still counting');
                    this._idleRecheckId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT, IDLE_RECHECK_SECONDS, () => {
                            this._idleRecheckId = 0;
                            this._checkIdleInhibited();
                            return GLib.SOURCE_REMOVE;
                        });
                    return;
                }
                this._idle = true;
                if (DEBUG)
                    console.log('[ScreenTime] idle');
                this._onPresenceChanged();
            });
    }

    // One-shot: Mutter removes the watch when it fires.
    _armActiveWatch() {
        if (this._activeWatchId)
            return;
        this._activeWatchId = this._idleMonitor.add_user_active_watch(() => {
            this._activeWatchId = 0;
            this._clearIdleRecheck();
            if (this._idle) {
                this._idle = false;
                if (DEBUG)
                    console.log('[ScreenTime] active');
                this._onPresenceChanged();
            }
        });
    }

    _clearIdleRecheck() {
        if (this._idleRecheckId) {
            GLib.source_remove(this._idleRecheckId);
            this._idleRecheckId = 0;
        }
    }

    _getMaxInterval() {
        return this._settings.get_int('max-interval');
    }

    _computeAway() {
        return this._idle || !!(this._shield && (this._shield.active || this._shield.locked));
    }

    _currentApp() {
        let win = global.display.focus_window;
        if (!win)
            return null;
        let app = Shell.WindowTracker.get_default().get_window_app(win);
        if (!app)
            return null;

        // window-backed apps (no .desktop file) get a per-launch `window:<n>` id;
        // WM_CLASS is stable across launches, so key those off it instead.
        if (app.is_window_backed()) {
            let wmClass = win.get_wm_class();
            if (wmClass)
                return { id: `wmclass:${wmClass}`, name: app.get_name() || wmClass, win };
        }
        return { id: app.get_id(), name: app.get_name(), win };
    }

    // Credits elapsed time (since _lastTime) to whatever path is currently
    // tracked and advances the clock. The store keeps whole seconds, so the
    // fraction it rounds away is left on the clock instead of being dropped:
    // sub-second flushes (a browser reporting rapid tab changes) then neither
    // lose time nor inflate it.
    _flush(now) {
        let elapsed = (now - this._lastTime) / 1000;
        let secs = Math.min(elapsed, this._getMaxInterval());
        if (!this._path) {
            this._lastTime = now;
            return;
        }
        if (secs <= 0) {
            // In debt from a previous round-up: leave the clock so the debt
            // is repaid by the next flush. A whole negative second cannot
            // come from rounding, so that is a clock jump: resynchronise.
            if (secs <= -1)
                this._lastTime = now;
            return;
        }
        let credited = Math.round(secs);
        if (credited > 0)
            this._store.addTime(this._path, this._names, credited);
        // When max-interval capped the stretch, the excess is discarded on
        // purpose (that is what the setting is for), so no residual.
        this._lastTime = secs < elapsed ? now : now - (secs - credited) * 1000;
    }

    // Starts tracking `app` (or nothing) at the app level only. The clock
    // belongs to _flush, which every caller runs first, so this never touches
    // it. The activity source is asked asynchronously; until it answers, time
    // belongs to the app alone.
    _setCurrent(app) {
        this._path = app ? [app.id] : null;
        this._names = app ? [app.name] : null;
        this._win = app?.win ?? null;
        this._resolveSeq++;
        if (DEBUG && this._path)
            console.log(`[ScreenTime] path: ${this._path.join(' / ')}`);
        if (app)
            this._kickResolve();
    }

    _kickResolve() {
        if (!this._path || !this._win || this._away)
            return;
        let seq = this._resolveSeq;
        this._sources.resolve(this._win, this._path[0]).then(sub => {
            // The window or presence changed while the resolve was running.
            if (seq !== this._resolveSeq || this._away || !this._path)
                return;
            this._applySubPath(sub);
        }).catch(e => console.error(`[ScreenTime] resolve apply failed: ${e.message}`));
    }

    // Switches to the resolved sub-path. Time since the last flush belongs to
    // the previous path, so it is banked first; pane switches inside one
    // window are then credited to within resolve latency, not the flush tick.
    _applySubPath(sub) {
        let path = [this._path[0]];
        let names = [this._names[0]];
        if (sub) {
            path.push(sub.activityId);
            names.push(sub.activityName);
            if (sub.detailId) {
                path.push(sub.detailId);
                names.push(sub.detailName);
            }
        }
        if (path.join('\0') === this._path.join('\0'))
            return;

        this._flush(Date.now());
        this._path = path;
        this._names = names;
        if (DEBUG)
            console.log(`[ScreenTime] path: ${path.join(' / ')}`);
    }

    // Going away banks the time so far and stops tracking; coming back re-reads
    // the focused window so the gap in between belongs to nobody.
    _setAway(away) {
        let now = Date.now();
        this._away = away;
        // Going away, this banks the tracked time; coming back, _path is
        // already null, so it only resets the clock for the app picked up next.
        this._flush(now);
        this._setCurrent(away ? null : this._currentApp());
    }

    _onPresenceChanged() {
        let away = this._computeAway();
        if (away !== this._away)
            this._setAway(away);
    }

    _onPrepareForSleep(aboutToSuspend) {
        if (aboutToSuspend)
            this._setAway(true);
        else if (!this._computeAway())
            this._setAway(false);   // resumed straight to the desktop
        // Otherwise the shield is up: stay away until it clears.
    }

    _onFocus() {
        if (this._away)
            return;

        let now = Date.now();
        this._flush(now);
        this._setCurrent(this._currentApp());
    }

    // Banks the interval so far and asks the sources again. Used by the 30s
    // tick and by a source announcing a change.
    _refresh() {
        if (this._away || !this._path)
            return;
        this._flush(Date.now());
        // The pane or tab may have changed without a focus event.
        this._kickResolve();
    }

    _onFlushTick() {
        this._refresh();
        return GLib.SOURCE_CONTINUE;
    }

    destroy() {
        if (this._focusId) {
            global.display.disconnect(this._focusId);
            this._focusId = null;
        }
        if (this._activeId) {
            this._shield.disconnect(this._activeId);
            this._activeId = null;
        }
        if (this._lockedId) {
            this._shield.disconnect(this._lockedId);
            this._lockedId = null;
        }
        if (this._sleepId) {
            this._loginManager.disconnect(this._sleepId);
            this._sleepId = null;
        }
        if (this._flushId) {
            GLib.source_remove(this._flushId);
            this._flushId = null;
        }
        if (this._idleSettingId) {
            this._settings.disconnect(this._idleSettingId);
            this._idleSettingId = null;
        }
        this._clearIdleWatches();
        this._flush(Date.now());
        this._resolveSeq++;   // drop any resolve still in flight
        this._sources.onChange = null;
        this._sources.destroy();
        this._sources = null;
        this._win = null;
        this._path = null;
        this._names = null;
    }
}
