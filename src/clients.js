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

// Whether `name` still names an entry in the client list at all - active or
// not, billable or not. A client can be deleted from Preferences while
// last-client (the setting the panel's Start button and the toggle-clock
// shortcut both start blindly) still remembers its name; starting a clock
// for a name no longer in the list at all would create billing history for
// a client nobody can see, export, or manage by name any more. Deliberately
// not restricted to activeClients(): an inactive client is still meant to
// stay clockable and exportable (see readClients's `active` field), just
// out of the popup's padding.
export function isKnownClient(settings, name) {
    if (!name)
        return false;
    return readClients(settings).some(c => c.name === name);
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
