// Rows shaped exactly like the invoicing app's TimeEntry, so pushing them
// over an API later is a transport change and nothing more.
//
// Export is by period: mergeSessions re-emits every row in the range on
// every call, and the invoicing side upserts on external_id. That keeps a
// corrected session in sync on re-export, but it cannot propagate a
// deletion — there is simply no row to send in these cases, so the
// receiving side is left stale until handled there or by hand:
//   - every session for a client-day is deleted (no row is emitted for that
//     day at all, not even a zero one, so a previously-sent row lingers);
//   - a client is made non-billable after already being exported (its
//     sessions stop producing rows, so its old rows are never zeroed);
//   - a client is renamed (a new name means a new external_id, orphaning
//     the row filed under the old one).
// A client-day that merges to 0 billable hours (e.g. a session corrected to
// billedHours: 0) is different from these: it still has a row and is still
// exported, with hours: 0, so the receiving side's total is corrected
// rather than left stuck at whatever it was before.

export const EXTERNAL_ID_PREFIX = 'screen-time';

// Returns a session's contribution in whole milliseconds, never hours.
// `hours` is a float that cannot exactly represent most decimal fractions
// (0.1, 0.335, ...), so accumulating a row's total in hours and rounding
// the sum can mis-round a value that lands exactly on a half-cent: 1.005h
// is actually stored as very slightly less than 1.005, so
// Math.round(1.005 * 100) / 100 gives 1.00, not 1.01 — and the same target
// reached a different way (summing three 0.335h sessions, say) can round
// the *other* direction, because the float error compounds differently
// each time. Milliseconds are whole numbers, so summing them across
// sessions is exact; Math.round() below on a billedHours override
// collapses that one multiplication's tiny float error back to the
// nearest integer millisecond before it has a chance to accumulate.
function sessionMs(session) {
    if (session.billedHours !== null && session.billedHours !== undefined)
        return Math.round(session.billedHours * 3600000);
    return session.endMs - session.startMs;
}

// Plain code-point comparison, not String.localeCompare(): rows upsert
// independently on external_id, so their relative order in the export
// carries no meaning to the receiving side — but it must still be the same
// on every machine, and localeCompare collates via ICU and the running
// locale, so identical input can sort differently from one machine to the
// next (and typically case-insensitively, unlike this).
function compareStrings(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

// One row per client per day. Identity is external_id, which is stable across
// re-exports: the receiving side upserts on it, so correcting a session and
// exporting the period again updates the row instead of duplicating it.
//
// A client name may itself contain ':' (e.g. "A:B"); external_id stays
// unambiguous to parse back because the date is always the fixed-width
// (YYYY-MM-DD) final component — strip the "screen-time:" prefix and the
// ":YYYY-MM-DD" suffix and whatever remains is the client, colons and all.
export function mergeSessions(sessions, clients, nowMs = Date.now()) {
    let billable = new Set(clients.filter(c => c.billable).map(c => c.name));
    let byKey = new Map();

    for (let session of sessions) {
        if (session.endMs === null || session.endMs === undefined)
            continue;
        if (!billable.has(session.client))
            continue;

        // A session whose endMs precedes its startMs has a negative
        // duration. update() and clockStore's load-time validation both
        // refuse this already, but these rows are money: mergeSessions
        // does not trust either of those upstream guards and drops it here
        // too, as a last line of defence against a hand-edited or
        // otherwise corrupted record.
        let ms = sessionMs(session);
        if (ms < 0)
            continue;

        let key = `${session.dayKey}\0${session.client}`;
        let row = byKey.get(key);
        if (!row) {
            row = {
                external_id: `${EXTERNAL_ID_PREFIX}:${session.client}:${session.dayKey}`,
                client: session.client,
                date: session.dayKey,
                totalMs: 0,
                notes: [],
            };
            byKey.set(key, row);
        }
        row.totalMs += ms;
        let note = session.description.trim();
        if (note.length > 0 && !row.notes.includes(note))
            row.notes.push(note);
    }

    return [...byKey.values()]
        .map(row => ({
            external_id: row.external_id,
            client: row.client,
            date: row.date,
            // Rounded once, on the total, straight from whole milliseconds:
            // row.totalMs / 36000 is row.totalMs / 3600000 (hours) * 100
            // (cents) in one division, so this is the only floating-point
            // step in the whole computation. See sessionMs() above for why
            // rounding hours instead — even just once — is not safe.
            hours: Math.round(row.totalMs / 36000) / 100,
            description: row.notes.join('; '),
        }))
        .sort((a, b) => compareStrings(a.date, b.date) || compareStrings(a.client, b.client));
}

export function toJSON(rows) {
    return `${JSON.stringify(rows, null, 2)}\n`;
}

// Not escaped here: a description or client starting with '=', '+', '-' or
// '@' can be read as a formula by a spreadsheet importer. The standard
// mitigation (prefixing a quote) was deliberately left out — it would
// import as part of the invoicing app's own text field, corrupting the
// data CSV exists to carry. Handle untrusted-CSV formula injection where
// the file is opened, not here.
function csvField(value) {
    let text = String(value);
    if (!/[",\n\r]/.test(text))
        return text;
    return `"${text.replace(/"/g, '""')}"`;
}

export function toCSV(rows) {
    let lines = ['external_id,client,date,hours,description'];
    for (let row of rows) {
        lines.push([
            row.external_id, row.client, row.date, row.hours, row.description,
        ].map(csvField).join(','));
    }
    return `${lines.join('\n')}\n`;
}
