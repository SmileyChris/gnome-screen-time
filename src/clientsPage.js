import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import { readClients, writeClients, readProjects, writeProjects } from './clients.js';
import { ShortcutRow } from './shortcutRow.js';

// Both the client and project delete buttons open the same shape of
// confirmation: cancel or a destructive delete, cancel by default and on
// Escape/close. Shared so the two dialogs can't quietly drift apart on
// their responses while their heading and body (the only parts that
// differ) stay with each caller.
function confirmDelete(window, heading, body, onDelete) {
    let dialog = new Adw.AlertDialog({ heading, body });
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('delete', 'Delete');
    dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_default_response('cancel');
    dialog.set_close_response('cancel');
    dialog.connect('response', (_dialog, response) => {
        if (response === 'delete')
            onDelete();
    });
    dialog.present(window);
}

// Focus alone does not scroll when the field was already the page's focus
// child, e.g. the window was left open and scrolled back up, or a client
// with several projects pushed the field further down than the last
// render. The page scrolls through an Adw.ClampScrollable, not a
// Gtk.Viewport, so this centres the field by hand when it is off screen.
function scrollIntoView(widget) {
    let scroller = widget?.get_ancestor(Gtk.ScrolledWindow);
    let [ok, rect] = scroller ? widget.compute_bounds(scroller) : [false, null];
    if (!ok)
        return;
    let adj = scroller.vadjustment;
    let top = rect.get_y();
    let height = rect.get_height();
    if (top < 0 || top + height > adj.page_size)
        adj.value = adj.value + top - (adj.page_size - height) / 2;
}

// The client list is the only place clients get created: the popup
// cannot take text input sanely. Active is the only way to retire a
// client short of deleting it outright: recentClients() (clients.js)
// excludes an inactive client from the popup's padding, but
// selectExportable() (timeExport.js) keeps it exportable regardless, so
// turning a client inactive - rather than deleting it - is how its
// history stays reachable from a later export. Projects follow the same
// active/delete rules, one level down, so a project row's switch and
// delete button read exactly like a client row's.
export function buildClientsPage(settings, window) {
    let page = new Adw.PreferencesPage({
        description: 'Clients the clock tracks time for. Inactive ones stay out of the popup ' +
            'but still export.',
    });

    let groups = [];
    let addRow = null;
    // The project entry row just created for each client, so a newly-added
    // project's field can get focus back after render() rebuilds every
    // group from scratch (see the "Add a project" handler below).
    let addProjectRows = new Map();

    // Built once, not by render(): its GSettings binding (the nudge
    // SpinRow) and the ShortcutRow's key listener must not be torn down
    // and recreated on every client or project change, only to be
    // re-seeded with the same values.
    let settingsGroup = new Adw.PreferencesGroup({ title: 'Settings' });
    settingsGroup.add(new ShortcutRow(
        settings, 'toggle-clock', 'Toggle the clock',
        'Stops the clock, or starts the client you used last.'));
    const nudgeRow = new Adw.SpinRow({
        title: 'Nudge when idle',
        subtitle: 'Minutes idle on the clock before a notification offers to stop it. 0 disables it.',
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 480, step_increment: 5 }),
    });
    settings.bind('clock-nudge-minutes', nudgeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    settingsGroup.add(nudgeRow);
    page.add(settingsGroup);

    const render = () => {
        for (let group of groups.splice(0))
            page.remove(group);
        addProjectRows.clear();

        let clients = readClients(settings);
        clients.forEach((client, i) => {
            let group = new Adw.PreferencesGroup({ title: client.name });

            let header = new Gtk.Box({ spacing: 6 });
            let active = new Gtk.Switch({
                active: client.active, valign: Gtk.Align.CENTER,
                tooltip_text: 'Active (offered in the popup)',
            });
            active.connect('notify::active', () => {
                let next = readClients(settings);
                next[i].active = active.active;
                writeClients(settings, next);
            });
            header.append(active);

            // Deleting is the only way to make a client's name stop
            // resolving at all: selectExportable() and mergeSessions()
            // (timeExport.js) key rows by client name, so a session
            // already recorded against a deleted client can never be
            // exported again unless the same name is added back -
            // turning it inactive instead keeps that door open.
            let remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => {
                confirmDelete(window, `Delete ${client.name}?`,
                    `Sessions already recorded for ${client.name} will no longer be ` +
                    'exported unless the client is added again, even though they stay ' +
                    'in the Timesheet. Consider turning it inactive instead - it drops ' +
                    'out of the popup but stays exportable.',
                    () => {
                        let next = readClients(settings);
                        next.splice(i, 1);
                        writeClients(settings, next);
                        // A deleted client's projects have no client left to
                        // belong to, and would otherwise resurface, orphaned,
                        // if the same name is ever added back.
                        writeProjects(settings, client.name, []);
                        render();
                    });
            });
            header.append(remove);
            group.header_suffix = header;

            for (let project of readProjects(settings, client.name)) {
                let row = new Adw.ActionRow({ title: project.name });

                let pactive = new Gtk.Switch({
                    active: project.active, valign: Gtk.Align.CENTER,
                    tooltip_text: 'Active (offered in the popup)',
                });
                pactive.connect('notify::active', () => {
                    let next = readProjects(settings, client.name);
                    next.find(p => p.name === project.name).active = pactive.active;
                    writeProjects(settings, client.name, next);
                });
                row.add_suffix(pactive);

                let premove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic', valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                });
                premove.connect('clicked', () => {
                    confirmDelete(window, `Delete ${project.name}?`,
                        `Sessions already recorded for ${project.name} will no longer be ` +
                        'exported under it unless the project is added again, even though ' +
                        'they stay in the Timesheet. Consider turning it inactive instead ' +
                        '- it drops out of the popup but stays exportable.',
                        () => {
                            let next = readProjects(settings, client.name)
                                .filter(p => p.name !== project.name);
                            writeProjects(settings, client.name, next);
                            render();
                        });
                });
                row.add_suffix(premove);

                group.add(row);
            }

            let addProjectRow = new Adw.EntryRow({ title: 'Add a project' });
            addProjectRow.connect('entry-activated', () => {
                let name = addProjectRow.text.trim();
                if (name.length === 0)
                    return;
                let next = readProjects(settings, client.name);
                if (next.some(p => p.name === name))
                    return;
                next.push({ name, active: true });
                writeProjects(settings, client.name, next);
                render();
                // render() built a new field for this client, so move focus
                // to it and the next name can be typed straight away.
                let newRow = addProjectRows.get(client.name);
                newRow?.grab_focus();
                scrollIntoView(newRow);
            });
            group.add(addProjectRow);
            addProjectRows.set(client.name, addProjectRow);

            groups.push(group);
            page.add(group);
        });

        let addClientGroup = new Adw.PreferencesGroup();
        addRow = new Adw.EntryRow({ title: 'Add a client' });
        addRow.connect('entry-activated', () => {
            let name = addRow.text.trim();
            if (name.length === 0)
                return;
            let next = readClients(settings);
            if (next.some(c => c.name === name))
                return;
            next.push({ name, active: true });
            writeClients(settings, next);
            addRow.text = '';
            render();
            // render() built a new field, so move focus to it and the next
            // name can be typed straight away.
            addRow.grab_focus();
            scrollIntoView(addRow);
        });
        addClientGroup.add(addRow);
        groups.push(addClientGroup);
        page.add(addClientGroup);

        // Adw.PreferencesPage can only append, so the Settings group -
        // built once, above, and never cleared from groups[] - is moved
        // back to the end here rather than rebuilt.
        page.remove(settingsGroup);
        page.add(settingsGroup);
    };

    render();

    return {
        page,
        // render() replaces the field on every change, so this reads the
        // current one rather than holding a reference.
        focusAddClient: () => {
            addRow?.grab_focus();
            scrollIntoView(addRow);
        },
    };
}
