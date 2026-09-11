import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import { dateKey } from './usageStore.js';

const STORE_DIR = GLib.build_filenamev([
    GLib.get_user_data_dir(), 'gnome-shell', 'screen-time'
]);
export const CLOCK_FILE = GLib.build_filenamev([STORE_DIR, 'clock.json']);

// A shorter gap than this since the last heartbeat means the Shell restarted
// under us (make reload, disable/enable); anything longer means the session
// really ended when the heartbeat stopped.
export const RESUME_GAP_MS = 120000;

function newId() {
    return GLib.uuid_string_random();
}

// Seconds a closed session contributes: the adjustment if one was made,
// otherwise the time actually on the clock.
function sessionSeconds(session, nowMs) {
    if (session.billedHours !== null && session.billedHours !== undefined)
        return session.billedHours * 3600;
    return ((session.endMs ?? nowMs) - session.startMs) / 1000;
}

export class ClockStore {
    constructor(settings) {
        this._settings = settings;
        this._sessions = [];
        this._dirty = false;
        this.onChange = null;
        this._ensureDir();
        this._load();
    }

    _ensureDir() {
        let dir = Gio.File.new_for_path(STORE_DIR);
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
    }

    // Sync, unlike UsageStore's async read: this file holds a handful of
    // small records per day, not the whole usage history.
    _load() {
        let file = Gio.File.new_for_path(CLOCK_FILE);
        if (!file.query_exists(null))
            return;
        try {
            let [, contents] = file.load_contents(null);
            let data = JSON.parse(new TextDecoder().decode(contents));
            this._sessions = data.sessions ?? [];
        } catch (e) {
            console.error(`[ScreenTime] clock load error: ${e.message}`);
        }
    }

    _save() {
        if (!this._dirty)
            return;
        try {
            let json = JSON.stringify({ sessions: this._sessions }, null, 2);
            Gio.File.new_for_path(CLOCK_FILE).replace_contents(
                new TextEncoder().encode(json),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
            this._dirty = false;
        } catch (e) {
            console.error(`[ScreenTime] clock save error: ${e.message}`);
        }
    }

    // Every mutation saves immediately. The file is small, and the Timesheet
    // window must never be able to observe a stale clock.
    _changed() {
        this._dirty = true;
        this._save();
        this.onChange?.();
    }

    _dayStartHour() {
        return this._settings.get_int('day-start-hour');
    }

    get running() {
        return this._sessions.find(s => s.endMs === null) ?? null;
    }

    start(client, nowMs = Date.now()) {
        let current = this.running;
        if (current && current.client === client)
            return current;
        if (current)
            this._close(current, nowMs);

        let session = {
            id: newId(),
            client,
            dayKey: dateKey(
                GLib.DateTime.new_from_unix_local(nowMs / 1000), this._dayStartHour()),
            startMs: nowMs,
            endMs: null,
            lastSeenMs: nowMs,
            billedHours: null,
            description: '',
            interrupted: false,
            cleanStop: false,
            exportedAt: null,
        };
        this._sessions.push(session);
        this._changed();
        return session;
    }

    stop(nowMs = Date.now()) {
        let current = this.running;
        if (!current)
            return null;
        this._close(current, nowMs);
        this._changed();
        return current;
    }

    toggle(client, nowMs = Date.now()) {
        return this.running ? this.stop(nowMs) : this.start(client, nowMs);
    }

    _close(session, endMs) {
        session.endMs = endMs;
        session.lastSeenMs = endMs;
    }

    sessionsForDay(dayKey) {
        return this._sessions
            .filter(s => s.dayKey === dayKey)
            .sort((a, b) => a.startMs - b.startMs);
    }

    billedSecondsForDay(dayKey, nowMs = Date.now()) {
        return this.sessionsForDay(dayKey)
            .reduce((sum, s) => sum + sessionSeconds(s, nowMs), 0);
    }

    destroy() {
        this._save();
        this._settings = null;
        this.onChange = null;
    }
}
