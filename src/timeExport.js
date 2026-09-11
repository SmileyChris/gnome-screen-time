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

function sessionHours(session) {
    if (session.billedHours !== null && session.billedHours !== undefined)
        return session.billedHours;
    return (session.endMs - session.startMs) / 3600000;
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

        let key = `${session.dayKey}\0${session.client}`;
        let row = byKey.get(key);
        if (!row) {
            row = {
                external_id: `${EXTERNAL_ID_PREFIX}:${session.client}:${session.dayKey}`,
                client: session.client,
                date: session.dayKey,
                hours: 0,
                notes: [],
            };
            byKey.set(key, row);
        }
        row.hours += sessionHours(session);
        let note = session.description.trim();
        if (note.length > 0 && !row.notes.includes(note))
            row.notes.push(note);
    }

    return [...byKey.values()]
        .map(row => ({
            external_id: row.external_id,
            client: row.client,
            date: row.date,
            // Rounded once, on the sum: rounding each session first would
            // drift the day's total by a cent's worth of time per row.
            hours: Math.round(row.hours * 100) / 100,
            description: row.notes.join('; '),
        }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.client.localeCompare(b.client));
}

export function toJSON(rows) {
    return `${JSON.stringify(rows, null, 2)}\n`;
}

function csvField(value) {
    let text = String(value);
    if (!/[",\n]/.test(text))
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
