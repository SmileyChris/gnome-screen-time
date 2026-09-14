// The heading line under each day in the Timesheet: every client's hours
// that day, in the order they were first clocked, then the total when more
// than one client worked. No imports, so plain gjs tests cover it.
//
// Each client's figure is rounded once from whole milliseconds, exactly as
// timeExport.js's mergeSessions() rounds that client's export row, and uses
// the hours override where one is set. The total adds those rounded
// figures, so it matches what the invoicing side sums from the rows.
// Summing hours as floats, or rounding the raw day sum, could be 0.01 out.

// A session's contribution in whole milliseconds. A running session counts
// up to `nowMs`. The override may legitimately be 0, so this is never a
// truthiness check.
function sessionMs(session, nowMs) {
    if (session.billedHours !== null && session.billedHours !== undefined)
        return Math.round(session.billedHours * 3600000);
    return (session.endMs ?? nowMs) - session.startMs;
}

function formatHours(cents) {
    return `${(cents / 100).toFixed(2)} h`;
}

export function dayHeading(sessions, nowMs = Date.now()) {
    let byClient = new Map();   // client -> { firstMs, ms }
    for (let session of sessions) {
        let entry = byClient.get(session.client);
        if (!entry) {
            entry = { firstMs: session.startMs, ms: 0 };
            byClient.set(session.client, entry);
        }
        entry.firstMs = Math.min(entry.firstMs, session.startMs);
        entry.ms += sessionMs(session, nowMs);
    }

    // Hundredths of an hour as integers, so the total adds exactly.
    let parts = [...byClient]
        .sort((a, b) => a[1].firstMs - b[1].firstMs)
        .map(([client, entry]) => ({ client, cents: Math.round(entry.ms / 36000) }));
    let text = parts.map(p => `${p.client} ${formatHours(p.cents)}`);
    if (parts.length > 1)
        text.push(`Total ${formatHours(parts.reduce((sum, p) => sum + p.cents, 0))}`);
    return text.join(' · ');
}
