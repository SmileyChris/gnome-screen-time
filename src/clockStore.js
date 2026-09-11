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
// D-Bus hardening: UpdateSession(id, fieldsJson) and StartSession(client)
// take these straight from another process, with no shape or length limit
// of their own - JSON carries none. `client` and `description` are free
// text a caller could paste anything into; bounded here so a pathological
// payload can't bloat clock.json or the Timesheet's UI without limit.
const MAX_CLIENT_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;
// billedHours is bounded for a different reason than size: keeping
// mergeSessions()'s arithmetic (timeExport.js: Math.round(billedHours *
// 3600000)) finite. A single session billing more than this is certainly a
// mistake - over a year of continuous, non-stop time - and a large enough
// override overflows that multiplication to Infinity well before reaching
// this bound; JSON.stringify(Infinity) silently becomes the literal `null`,
// so an unbounded billedHours could previously export as "hours": null
// instead of an obviously wrong number a human might actually notice.
const MAX_BILLED_HOURS = 10000;

function isValidField(key, value) {
    switch (key) {
    case 'id':
        return typeof value === 'string' && value.trim().length > 0;
    case 'client':
        return typeof value === 'string' && value.trim().length > 0 &&
            value.length <= MAX_CLIENT_LENGTH;
    case 'dayKey':
        return typeof value === 'string';
    case 'description':
        return typeof value === 'string' && value.length <= MAX_DESCRIPTION_LENGTH;
    case 'startMs':
    case 'lastSeenMs':
        return isValidTimestamp(value);
    case 'endMs':
        return value === null || isValidTimestamp(value);
    case 'billedHours':
        return value === null ||
            (isFiniteNumber(value) && value >= 0 && value <= MAX_BILLED_HOURS);
    case 'interrupted':
    case 'cleanStop':
        return typeof value === 'boolean';
    case 'exportedAt':
        return value === null || isValidTimestamp(value);
    default:
        return true;
    }
}

// Calendar-day arithmetic on dayKey strings (always YYYY-MM-DD - see
// sessionsForDays()), used by update() to shift a session's dayKey rather
// than re-derive it. Parsed and computed at midnight UTC rather than in
// local time: this is pure date arithmetic with no time-of-day component to
// preserve, and UTC has no DST transitions to land a candidate in a gap or
// an overlap the way local-time arithmetic could.
function daysBetweenDayKeys(fromKey, toKey) {
    let [fy, fm, fd] = fromKey.split('-').map(Number);
    let [ty, tm, td] = toKey.split('-').map(Number);
    let from = GLib.DateTime.new_utc(fy, fm, fd, 0, 0, 0);
    let to = GLib.DateTime.new_utc(ty, tm, td, 0, 0, 0);
    return Math.round(to.difference(from) / GLib.TIME_SPAN_DAY);
}

function shiftDayKey(dayKey, deltaDays) {
    if (deltaDays === 0)
        return dayKey;
    let [y, m, d] = dayKey.split('-').map(Number);
    return GLib.DateTime.new_utc(y, m, d, 0, 0, 0).add_days(deltaDays).format('%Y-%m-%d');
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
        // Whether the most recent _save() attempt (one that actually ran -
        // see _save()'s own dirty/readOnly guards) failed. Unlike
        // this._readOnly, which is permanent for this store's life once
        // set, this can flip back to false: a transient failure (disk full,
        // a permission change) can resolve itself, and the next successful
        // save says so. Distinct from readOnly, which means "never even
        // try again" - this means "the last attempt didn't land."
        this._saveFailing = false;
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
            this._saveFailing = false;
        } catch (e) {
            console.error(`[ScreenTime] clock save error: ${e.message}`);
            this._saveFailing = true;
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

    // True once _load() found it could not guarantee the original
    // clock.json's bytes were preserved (see the invariant documented on
    // this._readOnly above): every mutation below still updates memory, but
    // _changed()/_save() silently stop reaching disk. Exposed so a caller
    // that just wrote something derived from this store elsewhere (an
    // export file, say) can tell whether the in-memory change it also made
    // here - markExported(), for one - actually got recorded, rather than
    // reporting bare success and leaving that only in the journal.
    get readOnly() {
        return this._readOnly;
    }

    // True when the most recent _save() that actually ran (dirty, and not
    // already readOnly) threw. A billing edit can otherwise sit unpersisted
    // in memory while every D-Bus reply reports success, and after C1,
    // anything held only in memory is lost the moment a real logout/
    // shutdown closes this Shell process. Unlike readOnly, this can clear
    // itself: a transient failure (disk full, a permission change) can
    // resolve, and the very next successful save says so.
    get saveFailing() {
        return this._saveFailing;
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

    // Resolves sessions left open by a crash - or, when `resumeId` names one
    // still running from the same Shell process (extension.js's
    // module-scoped `heldSessionId`, set by release() below at the previous
    // disable()), a session release() simply paused rather than closed. ES
    // modules are cached for the life of the Shell, so that module-scoped
    // variable survives a disable()/enable() cycle (a lock, an idle blank,
    // a suspend) but dies with the Shell process itself - a crash, a real
    // logout/login, `make reload` (a fresh dev UUID means fresh module
    // state), a reboot - so resumeId is only ever non-null for the case it
    // names.
    //
    // Only one clock can run at a time, so more than one open session is
    // corruption (a hand edit, an interrupted write, a bad update), not
    // something that can legitimately keep accruing. At most one open
    // session is ever resumed:
    //  - if resumeId names one of them, that one is resumed unconditionally,
    //    regardless of the gap - release() already refreshed its lastSeenMs
    //    moments before disable() tore everything else down, so the elapsed
    //    gap says nothing about whether the Shell actually restarted, only
    //    about how long the extension was disabled (a lock, say);
    //  - otherwise the one with the freshest heartbeat gets the resume grace
    //    under RESUME_GAP_MS, exactly as before.
    // Every other open session is closed unconditionally at its own
    // lastSeenMs, whatever its age - the same "only one can ever resume"
    // rule as before resumeId existed.
    recover(nowMs = Date.now(), { resumeId = null } = {}) {
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

        let resumed = resumeId !== null ? open.find(s => s.id === resumeId) ?? null : null;
        let interrupted = [];
        let changed = false;

        if (resumed) {
            let others = open.filter(s => s !== resumed)
                .sort((a, b) => a.lastSeenMs - b.lastSeenMs);
            for (let session of others) {
                this._close(session, session.lastSeenMs);
                session.interrupted = true;
                interrupted.push(session);
            }
            resumed.lastSeenMs = nowMs;
            changed = true;
        } else {
            open.sort((a, b) => a.lastSeenMs - b.lastSeenMs);
            let mostRecent = open.pop();

            for (let session of open) {
                this._close(session, session.lastSeenMs);
                session.interrupted = true;
                interrupted.push(session);
            }

            let withinGap = nowMs - mostRecent.lastSeenMs < RESUME_GAP_MS;
            if (!withinGap) {
                this._close(mostRecent, mostRecent.lastSeenMs);
                mostRecent.interrupted = true;
                interrupted.push(mostRecent);
            }
            changed = interrupted.length > 0;
        }

        if (!changed)
            return null;
        this._changed();
        // interrupted is in ascending lastSeenMs order, so the last entry
        // is the most recently interrupted session.
        return interrupted.length > 0 ? interrupted[interrupted.length - 1] : null;
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
        //
        // Shifted, not re-derived from the current day-start-hour: the old
        // and new startMs are each turned into what dateKey() would say
        // under the CURRENT setting, and the stored dayKey moves by exactly
        // the calendar-day difference between those two - never recomputed
        // from scratch. A small edit that doesn't cross the current
        // boundary shifts by zero days and keeps the stored key untouched,
        // even if day-start-hour changed since this session was stamped (a
        // session stamped under day-start-hour 0, after the setting moves
        // to 4, keeps its key on a small start edit that a from-scratch
        // re-derivation would have refiled under the new rule). Crossing
        // the boundary shifts it by exactly one day, in either direction.
        // Re-deriving from scratch was also the double-billing bug this
        // guards against: moving an exported session's start back across
        // midnight would change its day, so a re-export would create a row
        // for the new day while the old day's row on the invoicing side
        // still kept its hours - billed twice. See the exportedAt check
        // just below.
        let nextDayKey = session.dayKey;
        if (allowed.startMs !== undefined) {
            let dayStartHour = this._dayStartHour();
            let oldDerivedKey = dateKey(
                GLib.DateTime.new_from_unix_local(session.startMs / 1000), dayStartHour);
            let newDerivedKey = dateKey(
                GLib.DateTime.new_from_unix_local(next.startMs / 1000), dayStartHour);
            nextDayKey = shiftDayKey(session.dayKey, daysBetweenDayKeys(oldDerivedKey, newDerivedKey));
        }

        // An exported session is money already on the invoicing side, keyed
        // by `screen-time:{client}:{dayKey}` (see timeExport.js): moving it
        // to a different day here would silently create a second row there
        // on the next export, with nothing to zero out the first. Refused
        // before anything is mutated, same as every check above.
        if (session.exportedAt !== null && nextDayKey !== session.dayKey)
            throw new Error('exported');

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

    // Stamps closed sessions as exported in one save and one onChange, so an
    // export of a month does not fire a change event per session. Unlike
    // update(), exportedAt is not on any external allowlist - this is the
    // only way to write it, which keeps it out of reach of a D-Bus caller
    // that only ever sends UpdateSession's documented fields. Unknown ids
    // and still-open sessions are skipped rather than rejected: a caller
    // exporting a period built its id list from sessionsForDays() a moment
    // earlier, and either could already be stale (a session removed, or
    // still running) by the time this runs.
    markExported(ids, stampMs = Date.now()) {
        if (!isValidTimestamp(stampMs))
            throw new Error('invalid');

        let wanted = new Set(ids);
        let stamped = 0;
        for (let session of this._sessions) {
            if (!wanted.has(session.id) || session.endMs === null)
                continue;
            session.exportedAt = stampMs;
            stamped++;
        }
        if (stamped > 0)
            this._changed();
        return stamped;
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

    // A billing period is a set of calendar days, not a time span: a session
    // starting at 23:00 on the 31st files under the 31st (dayKey is stamped
    // once, at creation - see start()), and must stay there even though its
    // wall-clock span pokes into the next month. Selecting by dayKey rather
    // than by overlapping [fromMs, toMs) is what keeps it out of next
    // month's export. Plain string comparison, since dayKey is always
    // YYYY-MM-DD: that format sorts the same lexicographically as
    // chronologically.
    sessionsForDays(fromDayKey, toDayKeyExclusive) {
        return this._sessions
            .filter(s => s.dayKey >= fromDayKey && s.dayKey < toDayKeyExclusive)
            .sort((a, b) => a.startMs - b.startMs);
    }

    // Clamped to the session's own startMs: a backward step in the system
    // clock (NTP correcting a fast clock, say) between this session's
    // start() and whatever closes it - most reachably start()'s own
    // same-instant switch to a different client - could otherwise write an
    // endMs before its startMs. The next load() would then exclude the
    // record as invalid and back the whole file up (see
    // isValidSessionRecord()), for a session that was otherwise perfectly
    // fine. Every _close() caller already passes a value that is either
    // nowMs or the session's own already-valid lastSeenMs, so this only
    // ever engages on that one clock-step scenario.
    _close(session, endMs) {
        let clampedEndMs = Math.max(endMs, session.startMs);
        session.endMs = clampedEndMs;
        session.lastSeenMs = clampedEndMs;
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
    // crash looks like on disk: no heartbeat refresh, nothing to say this
    // was a controlled pause rather than the Shell disappearing mid-tick.
    // Tests use this to simulate exactly that. release() below is the
    // controlled-pause counterpart; destroy() is the real-shutdown path.
    destroySilently() {
        this._save();
        this._settings = null;
        this.onChange = null;
    }

    // The disable() path once GNOME Shell disabling this extension on every
    // lock, idle blank and suspend no longer means "the billing clock
    // stopped": refreshes the running session's heartbeat to `nowMs` (so its
    // lastSeenMs reflects the instant disable() actually ran, not whatever
    // the last 30s heartbeat tick happened to catch), saves, and releases
    // this store's resources exactly like destroySilently() - but honestly,
    // since a heartbeat refresh did happen here. Returns the running
    // session's id (or null), which extension.js stashes in its
    // module-scoped `heldSessionId` so the next enable() in this same Shell
    // process can hand it back to recover() as `resumeId` and pick this
    // exact session back up regardless of how long the lock lasted.
    release(nowMs = Date.now()) {
        this.heartbeat(nowMs);
        let id = this.running?.id ?? null;
        this._settings = null;
        this.onChange = null;
        return id;
    }

    // A real end: closes the running session cleanly rather than leaving it
    // for the next recover() to find. extension.js's disable() no longer
    // calls this (see release() above) - it runs from the `global`
    // 'shutdown' handler at a genuine session end, and tests use it as
    // ordinary teardown when what happens to a still-running session
    // doesn't matter to what's being tested.
    destroy(nowMs = Date.now()) {
        this.closeForShutdown(nowMs);
        this._save();
        this._settings = null;
        this.onChange = null;
    }
}
