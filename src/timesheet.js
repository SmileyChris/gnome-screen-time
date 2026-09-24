import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';
import { TimesheetWindow } from './timesheetWindow.js';
import { dayFromArgs, pageFromArgs, noteFromArgs } from './timesheetArgs.js';

// Only the launcher runs anything, so process-identity setup belongs here,
// not in timesheetWindow.js: that module must only define things, since
// make check loads it by import.
GLib.set_prgname('screen-time-timesheet');

// The Timesheet runs outside the Shell, so it opens the extension's
// settings from the compiled schema shipped beside this file, the way
// Preferences does.
function extensionSettings() {
    let dir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    let schemasDir = GLib.build_filenamev([dir, 'schemas']);
    // The compiled schema ships in a schemas/ directory beside this file
    // once installed (`make build`); without one - e.g. GNOME's own schema
    // install path - fall back to the default source, the way
    // ExtensionPreferences.getSettings does.
    let source = GLib.file_test(schemasDir, GLib.FileTest.IS_DIR)
        ? Gio.SettingsSchemaSource.new_from_directory(
            schemasDir, Gio.SettingsSchemaSource.get_default(), false)
        : Gio.SettingsSchemaSource.get_default();
    let schema = source.lookup('org.gnome.shell.extensions.screen-time', false);
    if (!schema)
        throw new Error(`no compiled schema found in ${schemasDir} or the default schema source (run make build)`);
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
    // The popup's note button (see popupWidget.js's clock card): expands
    // that session and focuses its Note field. An unknown or malformed id
    // (noteFromArgs already rejected it) is simply not there.
    let noteId = noteFromArgs(commandLine.get_arguments());
    if (noteId)
        timesheet.showNote(noteId);
    timesheet.window.present();
    // Releases the launching process now. Without this it waits until gjs
    // garbage-collects commandLine, which can be seconds or never.
    commandLine.done();
    return 0;
});

app.run([System.programInvocationName, ...ARGV]);
