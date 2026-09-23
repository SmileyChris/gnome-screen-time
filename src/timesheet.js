import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import { TimesheetWindow } from './timesheetWindow.js';
import { dayFromArgs, pageFromArgs } from './timesheetArgs.js';

// Only the launcher runs anything, so process-identity setup belongs here,
// not in timesheetWindow.js: that module must only define things, since
// make check loads it by import.
GLib.set_prgname('screen-time-timesheet');

// The Timesheet runs outside the Shell, so it opens the extension's
// settings from the compiled schema shipped beside this file, the way
// Preferences does.
function extensionSettings() {
    let dir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    let source = Gio.SettingsSchemaSource.new_from_directory(
        GLib.build_filenamev([dir, 'schemas']),
        Gio.SettingsSchemaSource.get_default(), false);
    let schema = source.lookup('org.gnome.shell.extensions.screen-time', false);
    if (!schema)
        throw new Error(`no compiled schema in ${dir}/schemas (run make build)`);
    return new Gio.Settings({ settings_schema: schema });
}
const settings = extensionSettings();

const app = new Adw.Application({
    application_id: 'org.gnome.Shell.Extensions.ScreenTime.Timesheet',
    flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE,
});

// No NON_UNIQUE flag, so a second launch hands its command line to this
// instance over D-Bus and exits. The window is built once and then raised,
// and a --day argument (from the popup's "Clocked" card) scrolls it to
// that day.
let timesheet = null;
app.connect('command-line', (_app, commandLine) => {
    if (!app.active_window)
        timesheet = new TimesheetWindow(app, settings);
    timesheet.showDay(dayFromArgs(commandLine.get_arguments()));
    timesheet.showPage(pageFromArgs(commandLine.get_arguments()));
    timesheet.window.present();
    // Releases the launching process now. Without this it waits until gjs
    // garbage-collects commandLine, which can be seconds or never.
    commandLine.done();
    return 0;
});

app.run([System.programInvocationName, ...ARGV]);
