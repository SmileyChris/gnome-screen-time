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

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

// Sane bounds for any epoch-ms timestamp this module writes or accepts:
// 2000-01-01T00:00:00Z (inclusive) to 2100-01-01T00:00:00Z (exclusive).
// Number.isInteger(1e300) is true, so a bare finite-integer check lets a
// wildly out-of-range value through: it would pass validation, get written
// by Object.assign, and only then blow up GLib.DateTime.new_from_unix_local
// (or some later consumer) with "value is out of range for int64" - after
// the session was already mutated. Bounding the magnitude here keeps that
// failure at validation time, before anything is touched, for every caller.
const MIN_TIMESTAMP_MS = 946684800000;   // 2000-01-01T00:00:00Z
const MAX_TIMESTAMP_MS = 4102444800000;  // 2100-01-01T00:00:00Z, exclusive

function isValidTimestamp(value) {
    return Number.isSafeInteger(value) &&
        value >= MIN_TIMESTAMP_MS && value < MAX_TIMESTAMP_MS;
}

// Per-field type rules shared by update() and _load(). update() is reached
// from D-Bus (UpdateSession(id, fieldsJson) -> JSON.parse() -> update()), so
// a payload from another process can carry any type at all; _load() reads a
// clock.json that could equally be hand-edited or partially corrupted. Both
// are untrusted input crossing a trust boundary into billing data, so one
// function is used by both rather than risking the two sets of rules
// drifting apart. `default: true` covers keys neither caller ever passes
// here (update()'s allowlist and _load()'s field list both call this only
// with keys they know about).
function isValidField(key, value) {
    switch (key) {
    case 'id':
    case 'client':
        return typeof value === 'string' && value.trim().length > 0;
    case 'dayKey':
    case 'description':
        return typeof value === 'string';
    case 'startMs':
    case 'lastSeenMs':
        return isValidTimestamp(value);
    case 'endMs':
        return value === null || isValidTimestamp(value);
    case 'billedHours':
        return value === null || (isFiniteNumber(value) && value >= 0);
    case 'interrupted':
    case 'cleanStop':
        return typeof value === 'boolean';
    case 'exportedAt':
        return value === null || isValidTimestamp(value);
    default:
        return true;
    }
}

// A record loaded from clock.json is the full shape start()/recover() write,
// not the partial field set update() accepts. Booleans and exportedAt are
// tolerated when absent and default below; everything else is required.
const REQUIRED_RECORD_FIELDS =
    ['id', 'client', 'dayKey', 'startMs', 'endMs', 'lastSeenMs', 'billedHours', 'description'];
const OPTIONAL_RECORD_FIELDS = ['interrupted', 'cleanStop', 'exportedAt'];

function isValidSessionRecord(record) {
    if (typeof record !== 'object' || record === null)
        return false;
    for (let key of REQUIRED_RECORD_FIELDS) {
        if (!isValidField(key, record[key]))
            return false;
    }
    for (let key of OPTIONAL_RECORD_FIELDS) {
        if (key in record && record[key] !== undefined && !isValidField(key, record[key]))
            return false;
    }
    // isValidField() checks each field in isolation, so it cannot catch an
    // endMs that individually looks like a fine timestamp but precedes its
    // own startMs - only checkable here, once both are already known to be
    // individually valid. update() refuses this same shape live; this is
    // the same guarantee for a record that reached disk some other way (a
    // hand edit, a partially-written file) and would otherwise load
    // straight into billing data with a negative duration.
    if (record.endMs !== null && record.endMs < record.startMs)
        return false;
    return true;
}

function normalizeSessionRecord(record) {
    return {
        id: record.id,
        client: record.client,
        dayKey: record.dayKey,
        startMs: record.startMs,
        endMs: record.endMs,
        lastSeenMs: record.lastSeenMs,
        billedHours: record.billedHours,
        description: record.description,
        interrupted: record.interrupted ?? false,
        cleanStop: record.cleanStop ?? false,
        exportedAt: record.exportedAt ?? null,
    };
}

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
        // Set for the rest of this store's life the moment _load() finds
        // that it cannot guarantee the original file's bytes are preserved
        // somewhere (an unreadable file, or a corrupt one it failed to back
        // up). The invariant is absolute: if this store could not keep a
        // copy of what was already on disk, it must never overwrite it,
        // however much has since happened in memory. The clock still works
        // entirely in memory either way.
        this._readOnly = false;
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
            return;   // first run: nothing to load, nothing to back up

        let contents;
        try {
            [, contents] = file.load_contents(null);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                return;   // deleted between query_exists() and here: same as never existing
            // Any other read failure (permissions, I/O error) means the
            // original bytes are inaccessible here, not merely absent.
            // This store must never write a fresh clock.json over a file
            // it was never actually able to read - that would silently
            // discard whatever billing history the file holds, with no
            // trace and no chance to recover it. Read-only for the rest of
            // this store's life, even once whatever caused this is fixed:
            // the clock still works entirely in memory, it just never
            // saves again.
            this._readOnly = true;
            console.error(`[ScreenTime] clock load error: ${e.message}; clock.json is ` +
                'read-only for this session - changes will not be saved');
            return;
        }

        if (contents.length === 0) {
            // Genuinely empty: nothing was ever written here, so there is
            // nothing to preserve and nothing has been lost. This is not
            // corruption - no backup, no read-only mode, just an empty
            // store. (Distinguishing this here also sidesteps
            // replace_contents()'s own behaviour on empty content, which
            // _backupCorruptFile() would otherwise have to special-case.)
            console.error('[ScreenTime] clock load: clock.json is empty; starting with no sessions');
            this._sessions = [];
            return;
        }

        let records = this._parseSessionRecords(contents);
        if (records === null) {
            // Unparseable JSON, a non-object top level, or a `sessions`
            // that isn't an array: never default to an empty session list
            // silently here. The next _save() - any tap of the clock -
            // would otherwise overwrite the file with nothing, discarding
            // the user's whole billing history with no trace. Back the raw
            // bytes up first, then start from empty.
            let { ok, path: backupPath } = this._backupCorruptFile(contents);
            if (!ok) {
                // The backup itself failed: the original bytes were never
                // actually copied anywhere else, so this file must not be
                // overwritten either - same invariant as the unreadable-
                // file case above, just discovered one step later.
                this._readOnly = true;
                console.error('[ScreenTime] clock load: clock.json is malformed and could not be ' +
                    'backed up; clock.json is read-only for this session - changes will not be saved');
                this._sessions = [];
                return;
            }
            console.error('[ScreenTime] clock load: clock.json is malformed and could not ' +
                `be read as a sessions array; original backed up to ${backupPath}`);
            this._sessions = [];
            return;
        }

        let valid = [];
        let invalidCount = 0;
        for (let record of records) {
            if (isValidSessionRecord(record))
                valid.push(normalizeSessionRecord(record));
            else
                invalidCount++;
        }
        // Never silently discard a billing record: an invalid one is
        // excluded from memory, but the file it came from is preserved
        // byte-for-byte first - once per load, not once per record.
        if (invalidCount > 0) {
            let { ok, path: backupPath } = this._backupCorruptFile(contents);
            if (!ok) {
                this._readOnly = true;
                console.error(`[ScreenTime] clock load: excluded ${invalidCount} invalid session ` +
                    'record(s) but the original could not be backed up; clock.json is read-only ' +
                    'for this session - changes will not be saved');
            } else {
                console.error(`[ScreenTime] clock load: excluded ${invalidCount} invalid ` +
                    `session record(s); original backed up to ${backupPath}`);
            }
        }
        this._sessions = valid;
    }

    // Parses `contents` (the raw bytes of clock.json) into its `sessions`
    // array. Returns null - never an empty array - when the bytes cannot be
    // turned into one: unparseable JSON, a non-object (or array) top level,
    // or a `sessions` key that isn't itself an array. null is _load()'s
    // signal to back the file up rather than silently proceeding as if it
    // held zero sessions.
    _parseSessionRecords(contents) {
        let data;
        try {
            data = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            return null;
        }
        if (typeof data !== 'object' || data === null || Array.isArray(data))
            return null;
        if (!Array.isArray(data.sessions))
            return null;
        return data.sessions;
    }

    // Copies the as-loaded bytes verbatim, before anything is excluded, so a
    // corrupt file's only copy is never just the records this run managed to
    // parse. Returns { ok, path }: `ok` is false whenever the bytes were not
    // actually preserved - a thrown error, or replace_contents() returning
    // `false` without throwing at all (its documented behaviour is a bare
    // GLib-level assertion failure on empty content, not a catchable error;
    // _load() rules that case out before ever calling this, but the return
    // value is still checked here rather than assumed). Callers must look at
    // `ok`, not just the absence of an exception.
    _backupCorruptFile(contents) {
        let backupPath = `${CLOCK_FILE}.invalid-${Math.floor(Date.now() / 1000)}`;
        let ok = false;
        try {
            [ok] = Gio.File.new_for_path(backupPath).replace_contents(
                contents, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.error(`[ScreenTime] clock backup error: ${e.message}`);
            ok = false;
        }
        return { ok, path: backupPath };
    }

    _save() {
        if (!this._dirty)
            return;
        // The one loud console.error already happened in _load() the
        // moment read-only mode began; every _save() it silently skips
        // after that must not repeat it.
        if (this._readOnly)
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
        // Same rule update() applies to `client`: reached over D-Bus as
        // StartSession(client), so this can be anything JSON can carry,
        // including "" or whitespace. Checked first, before anything else,
        // so a rejected call never touches the store.
        if (!isValidField('client', client))
            throw new Error('invalid');
        // A machine whose clock is wrong (a dead CMOS battery booting into
        // 1970, say) can hand Date.now() itself a nonsensical value. This
        // is a user-facing action, so the failure must be visible to the
        // caller rather than silently clamped or ignored.
        if (!isValidTimestamp(nowMs))
            throw new Error('invalid');

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
        // Same reasoning as start(): a user action, so a bad nowMs must
        // throw rather than be silently absorbed or clamped.
        if (!isValidTimestamp(nowMs))
            throw new Error('invalid');
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
        // Runs on an unattended GLib timeout - it must never throw. A bad
        // nowMs (the same wrong-clock scenario start()/stop() guard
        // against) is skipped silently rather than written: the
        // alternative is a garbage lastSeenMs poisoning the stray-session
        // clamp in _sessionSeconds() later.
        if (!isValidTimestamp(nowMs))
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
        // Runs once, at enable(). On a machine whose clock is wrong (the
        // same dead-CMOS-battery scenario start()/stop()/heartbeat() guard
        // against), nowMs - lastSeenMs is meaningless: it cannot tell a
        // genuine `make reload` from a real outage, so it must not guess
        // either way. Doing nothing leaves the open session exactly as
        // found - not resumed, not closed, not split - for a later,
        // correctly-timed recover() to resolve once the clock is sane.
        if (!isValidTimestamp(nowMs))
            return null;

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
        // Runs from disable(), which must always complete - never throw
        // here. A bad nowMs falls back to the session's own lastSeenMs,
        // which is already known-valid: start() and heartbeat() only ever
        // write a validated timestamp there.
        let closeAt = isValidTimestamp(nowMs) ? nowMs : current.lastSeenMs;
        this._close(current, closeAt);
        current.cleanStop = true;
        this._changed();
        return current;
    }

    update(id, fields, nowMs = Date.now()) {
        // Every comparison against NaN is false, so an out-of-range nowMs
        // would make _overlaps() below never detect a conflict - exactly
        // the hole that let this persist two overlapping sessions to disk.
        // Checked first, before even looking up the session, so a bad
        // value can never reach any check that assumes a sane "now".
        if (!isValidTimestamp(nowMs))
            throw new Error('invalid');

        let session = this._sessions.find(s => s.id === id);
        if (!session)
            return null;

        let allowed = {};
        for (let key of UPDATABLE_FIELDS) {
            if (!(key in fields))
                continue;
            let value = fields[key];
            // A key present with an explicit `undefined` value is treated as
            // absent rather than as a request to write `undefined`: JSON
            // from a D-Bus caller cannot carry `undefined`, but a payload
            // built by hand can, and writing it through would bypass the
            // reopen guard below and poison billing with NaN just like a
            // bad type would.
            if (value === undefined)
                continue;
            if (!isValidField(key, value))
                throw new Error('invalid');
            allowed[key] = value;
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

        // Moving a start across the boundary re-files the session, which is
        // the one case where dayKey legitimately changes. Derived here, on
        // `next`, before anything is mutated: every check above has already
        // passed, but deriving a calendar day from an instant is itself an
        // operation that can fail (an out-of-range value slipping past
        // isValidTimestamp some other way, a GLib quirk), and it must not
        // be able to throw after Object.assign has already run - that was
        // the exact bug where a bad startMs got written, then the dayKey
        // re-stamp threw, leaving the session mutated in memory with
        // nothing to undo it.
        let nextDayKey = allowed.startMs !== undefined
            ? dateKey(GLib.DateTime.new_from_unix_local(next.startMs / 1000), this._dayStartHour())
            : session.dayKey;

        Object.assign(session, allowed);
        session.dayKey = nextDayKey;
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

    // Unlike sessionsInRange(), not bounded by "now" - a session started in
    // the future (however that came about) must still be findable by id.
    sessionById(id) {
        return this._sessions.find(s => s.id === id) ?? null;
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
