import GLib from 'gi://GLib';

// The client list lives in GSettings rather than in clock.json, so the
// preferences process can edit it without writing a file the Shell owns.
export function readClients(settings) {
    return settings.get_value('clients').deepUnpack()
        .map(([name, active, billable]) => ({ name, active, billable }));
}

export function writeClients(settings, list) {
    settings.set_value('clients', new GLib.Variant('a(sbb)',
        list.map(c => [c.name, c.active, c.billable])));
}

export function activeClients(settings) {
    return readClients(settings).filter(c => c.active);
}

// What the popup lists: clients used today, in the order they were first
// clocked, padded from the active list so the section never collapses to a
// single row.
export function recentClients(settings, clock, dayKey, min = 4) {
    let names = [];
    for (let session of clock.sessionsForDay(dayKey)) {
        if (!names.includes(session.client))
            names.push(session.client);
    }
    for (let client of activeClients(settings)) {
        if (names.length >= min)
            break;
        if (!names.includes(client.name))
            names.push(client.name);
    }
    return names;
}
