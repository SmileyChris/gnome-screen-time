import GLib from 'gi://GLib';

// The client list lives in GSettings rather than in clock.json, so the
// preferences process can edit it without writing a file the Shell owns.
// Stored as a(sbb): name, active, and a third value that is no longer used
// (it was a billable flag). GSettings cannot change a key's type without
// losing what is stored, so the shape stays: the third value is written as
// true and ignored on read.
export function readClients(settings) {
    return settings.get_value('clients').deepUnpack()
        .map(([name, active]) => ({ name, active }));
}

export function writeClients(settings, list) {
    settings.set_value('clients', new GLib.Variant('a(sbb)',
        list.map(c => [c.name, c.active, true])));
}

export function activeClients(settings) {
    return readClients(settings).filter(c => c.active);
}

// Whether `name` still names an entry in the client list at all - active or
// not. A client can be deleted from the Timesheet's Clients page while
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

// The client a paused clock would resume, or null. Paused means no session
// is running but last-client still names a client on the list. last-client
// is empty once stopped (stop forgets it), on a fresh install and before any
// client has been clocked. It can also name a client since deleted from the
// Timesheet's Clients page (see isKnownClient). `running` is
// ClockStore.running. The clock card and the client rows both call this, so
// they can never disagree about which client is paused.
export function pausedClient(settings, running) {
    if (running)
        return null;
    let last = settings.get_string('last-client');
    return isKnownClient(settings, last) ? last : null;
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

// Projects are optional subdivisions of a client, named to match the
// invoicing app's projects. Stored as two maps keyed by client name, so a
// client with none has no entry at all and `clients` keeps its shape. A
// session with no project is the client's General time; "General" itself
// is never stored.
function readMap(settings, key) {
    return settings.get_value(key).deepUnpack();
}

function writeMap(settings, key, map) {
    settings.set_value(key, new GLib.Variant('a{sas}', map));
}

export function readProjects(settings, client) {
    let inactive = new Set(readMap(settings, 'inactive-projects')[client] ?? []);
    return (readMap(settings, 'projects')[client] ?? [])
        .map(name => ({ name, active: !inactive.has(name) }));
}

// An empty list removes the client from both maps, which is also how a
// deleted client's projects are dropped.
export function writeProjects(settings, client, list) {
    let all = readMap(settings, 'projects');
    let inactive = readMap(settings, 'inactive-projects');
    let off = list.filter(p => !p.active).map(p => p.name);
    if (list.length > 0)
        all[client] = list.map(p => p.name);
    else
        delete all[client];
    if (off.length > 0)
        inactive[client] = off;
    else
        delete inactive[client];
    writeMap(settings, 'projects', all);
    writeMap(settings, 'inactive-projects', inactive);
}

export function activeProjects(settings, client) {
    return readProjects(settings, client).filter(p => p.active).map(p => p.name);
}

// The project resume and the shortcut restart for `client`: last-project
// when it is still on that client's list, active or not (like
// isKnownClient), otherwise null, which is General.
export function lastProject(settings, client) {
    let name = settings.get_string('last-project');
    if (!name)
        return null;
    return readProjects(settings, client).some(p => p.name === name) ? name : null;
}
