import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk?version=4.0';
import { readClients, writeClients } from './clients.js';
import { ShortcutRow } from './shortcutRow.js';

// The client list is the only place clients get created: the popup
// cannot take text input sanely. Active is the only way to retire a
// client short of deleting it outright: recentClients() (clients.js)
// excludes an inactive client from the popup's padding, but
// selectExportable() (timeExport.js) keeps it exportable regardless, so
// turning a client inactive - rather than deleting it - is how its
// history stays reachable from a later export.
export function buildClientsPage(settings, window) {
    let page = new Adw.PreferencesPage();
    const clientsGroup = new Adw.PreferencesGroup({
        title: 'Clients',
        description: 'Clients the clock tracks time for. Inactive ones stay out of the popup ' +
            'but still export.',
    });
    page.add(clientsGroup);

    const clientRows = [];
    let addRow = null;

    const renderClients = () => {
        for (let row of clientRows.splice(0))
            clientsGroup.remove(row);
        let list = readClients(settings);
        list.forEach((client, i) => {
            let row = new Adw.ActionRow({ title: client.name });

            let active = new Gtk.Switch({
                active: client.active, valign: Gtk.Align.CENTER,
                tooltip_text: 'Active (offered in the popup)',
            });
            active.connect('notify::active', () => {
                let next = readClients(settings);
                next[i].active = active.active;
                writeClients(settings, next);
            });
            row.add_suffix(active);

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
                let dialog = new Adw.AlertDialog({
                    heading: `Delete ${client.name}?`,
                    body: `Sessions already recorded for ${client.name} will no longer be ` +
                        'exported unless the client is added again, even though they stay ' +
                        'in the Timesheet. Consider turning it inactive instead - it drops ' +
                        'out of the popup but stays exportable.',
                });
                dialog.add_response('cancel', 'Cancel');
                dialog.add_response('delete', 'Delete');
                dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
                dialog.set_default_response('cancel');
                dialog.set_close_response('cancel');
                dialog.connect('response', (_dialog, response) => {
                    if (response !== 'delete')
                        return;
                    let next = readClients(settings);
                    next.splice(i, 1);
                    writeClients(settings, next);
                    renderClients();
                });
                dialog.present(window);
            });
            row.add_suffix(remove);

            clientsGroup.add(row);
            clientRows.push(row);
        });

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
            renderClients();
            // renderClients() built a new field, so move focus to it
            // and the next name can be typed straight away.
            addRow.grab_focus();
        });
        clientsGroup.add(addRow);
        clientRows.push(addRow);
    };

    renderClients();

    clientsGroup.add(new ShortcutRow(
        settings, 'toggle-clock', 'Toggle the clock',
        'Stops the clock, or starts the client you used last.'));

    const nudgeRow = new Adw.SpinRow({
        title: 'Nudge when idle',
        subtitle: 'Minutes idle on the clock before a notification offers to stop it. 0 disables it.',
        adjustment: new Gtk.Adjustment({ lower: 0, upper: 480, step_increment: 5 }),
    });
    settings.bind('clock-nudge-minutes', nudgeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
    clientsGroup.add(nudgeRow);

    return {
        page,
        // renderClients() replaces the field on every change, so this reads
        // the current one rather than holding a reference.
        focusAddClient: () => addRow?.grab_focus(),
    };
}
