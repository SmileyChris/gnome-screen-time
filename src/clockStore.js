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

// The only fields update() may touch. A later task exposes update() over
// D-Bus as UpdateSession(id, fieldsJson) -> JSON.parse() -> update(), so a
// payload from another process could otherwise write any property at all -
// including `id`, or fields like `interrupted`/`cleanStop` that only this
// module should set. Unknown keys are dropped silently rather than
// rejected, since a future, harmless field added to a payload should not
// make the whole call fail.
const UPDATABLE_FIELDS = ['billedHours', 'description', 'startMs', 'endMs', 'client'];

export class ClockStore {
    constructor(settings) {
        this._settings = settings;
        this._sessions = [];
        this._dirty = false;
        this.onChange = null;
        // Session ids already reported by _sessionSeconds()'s anomaly log,
        // for the lifetime of this store. billedSecondsForDay() is polled
        // on a timer by later code, so an unthrottled console.error would
        // spam the journal forever for one persistent stray session; the
        // clamping itself is unaffected, only the logging is throttled.
        // recover() is what actually heals this state at startup, so this
        // only has to cover anomalies that arise mid-run.
        this._reportedAnomalies = new Set();
        this._ensureDir();
        this._load();
    }

    // Seconds a session contributes: the adjustment if one was made,
    // otherwise the time actually on the clock. `runningId` is the id
    // `running` currently returns; an open session that is not it is an
    // anomaly (a hand edit, an interrupted write, a stale record) rather
    // than something the user can still be billed for indefinitely, so it
    // is clamped to its last known heartbeat and logged once rather than
    // left to grow forever, silently.
    _sessionSeconds(session, nowMs, runningId) {
        if (session.billedHours !== null && session.billedHours !== undefined)
            return session.billedHours * 3600;
        if (session.endMs !== null)
            return (session.endMs - session.startMs) / 1000;
        if (session.id === runningId)
            return (nowMs - session.startMs) / 1000;
        if (!this._reportedAnomalies.has(session.id)) {
            this._reportedAnomalies.add(session.id);
            console.error(`[ScreenTime] clock: stray open session ${session.id} (${session.client}) ` +
                `is not the running one; clamped to its last heartbeat`);
        }
        return (session.lastSeenMs - session.startMs) / 1000;
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

        // Build the incoming session fully before mutating anything: if this
        // throws (an out-of-range nowMs breaks dateKey(), say), the store is
        // left exactly as it was rather than with the outgoing session
        // closed and nothing to replace it.
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

        if (current)
            this._close(current, nowMs);
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

    // Marks dirty on every tick: _save() skips a clean store, so a heartbeat
    // that only touched memory would leave a stale lastSeenMs on disk and
    // recover() would bill the session short.
    heartbeat(nowMs = Date.now()) {
        let current = this.running;
        if (!current)
            return;
        current.lastSeenMs = nowMs;
        this._dirty = true;
        this._save();
    }

    // Resolves sessions left open by a crash. On Wayland a Shell crash is a
    // logout, so in practice the resume branch fires only for `make reload`
    // and disable/enable cycles.
    //
    // Only one clock can run at a time, so more than one open session is
    // corruption (a hand edit, an interrupted write, a bad update), not
    // something that can legitimately keep accruing. The one with the
    // freshest heartbeat is treated as the real one and gets the resume
    // grace under RESUME_GAP_MS; every other open session is closed
    // unconditionally at its own lastSeenMs, whatever its age.
    recover(nowMs = Date.now()) {
        let open = this._sessions.filter(s => s.endMs === null);
        if (open.length === 0)
            return null;

        open.sort((a, b) => a.lastSeenMs - b.lastSeenMs);
        let mostRecent = open.pop();

        let interrupted = [];
        for (let session of open) {
            this._close(session, session.lastSeenMs);
            session.interrupted = true;
            interrupted.push(session);
        }

        let resumed = nowMs - mostRecent.lastSeenMs < RESUME_GAP_MS;
        if (!resumed) {
            this._close(mostRecent, mostRecent.lastSeenMs);
            mostRecent.interrupted = true;
            interrupted.push(mostRecent);
        }

        if (interrupted.length === 0)
            return null;
        this._changed();
        // interrupted is in ascending lastSeenMs order, so the last entry
        // is the most recently interrupted session.
        return interrupted[interrupted.length - 1];
    }

    closeForShutdown(nowMs = Date.now()) {
        let current = this.running;
        if (!current)
            return null;
        this._close(current, nowMs);
        current.cleanStop = true;
        this._changed();
        return current;
    }

    update(id, fields, nowMs = Date.now()) {
        let session = this._sessions.find(s => s.id === id);
        if (!session)
            return null;

        let allowed = {};
        for (let key of UPDATABLE_FIELDS) {
            if (key in fields)
                allowed[key] = fields[key];
        }

        let next = { ...session, ...allowed };
        // Reopening a closed session (endMs moving from non-null to null)
        // is start()'s job, not update()'s: allowing it here would let a
        // payload reaching update() from outside this module (a later
        // task's D-Bus surface, say) put a second concurrent open session
        // back on disk - exactly what recover() exists to clean up. A
        // session that is already open and simply resends its own null
        // endMs (e.g. alongside a startMs edit) is not a reopen and stays
        // allowed.
        if (session.endMs !== null && next.endMs === null)
            throw new Error('reopen');
        if (next.endMs !== null && next.endMs < next.startMs)
            throw new Error('backwards');
        if (this._overlaps(next, nowMs))
            throw new Error('overlap');

        Object.assign(session, allowed);
        // Moving a start across the boundary re-files the session, which is
        // the one case where dayKey legitimately changes.
        if (allowed.startMs !== undefined) {
            session.dayKey = dateKey(
                GLib.DateTime.new_from_unix_local(session.startMs / 1000),
                this._dayStartHour());
        }
        this._changed();
        return session;
    }

    // End-to-start contact is not an overlap: switching produces exactly that.
    _overlaps(candidate, nowMs = Date.now()) {
        let aStart = candidate.startMs;
        let aEnd = candidate.endMs ?? nowMs;
        return this._sessions.some(other => {
            if (other.id === candidate.id)
                return false;
            let bEnd = other.endMs ?? nowMs;
            return aStart < bEnd && other.startMs < aEnd;
        });
    }

    remove(id) {
        let i = this._sessions.findIndex(s => s.id === id);
        if (i < 0)
            return false;
        this._sessions.splice(i, 1);
        this._changed();
        return true;
    }

    sessionsInRange(fromMs, toMs, nowMs = Date.now()) {
        return this._sessions
            .filter(s => s.startMs < toMs && (s.endMs ?? nowMs) > fromMs)
            .sort((a, b) => a.startMs - b.startMs);
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
        let runningId = this.running?.id ?? null;
        return this.sessionsForDay(dayKey)
            .reduce((sum, s) => sum + this._sessionSeconds(s, nowMs, runningId), 0);
    }

    // Today's billed seconds per client, by the same rule as
    // billedSecondsForDay, so a row and the day total can never disagree.
    billedSecondsByClient(dayKey, nowMs = Date.now()) {
        let runningId = this.running?.id ?? null;
        let byClient = new Map();
        for (let session of this.sessionsForDay(dayKey)) {
            let seconds = this._sessionSeconds(session, nowMs, runningId);
            byClient.set(session.client, (byClient.get(session.client) ?? 0) + seconds);
        }
        return byClient;
    }

    // Drops the store without closing the running session, which is what a
    // crash looks like on disk. destroy() is the clean path.
    destroySilently() {
        this._save();
        this._settings = null;
        this.onChange = null;
    }

    destroy(nowMs = Date.now()) {
        this.closeForShutdown(nowMs);
        this._save();
        this._settings = null;
        this.onChange = null;
    }
}
