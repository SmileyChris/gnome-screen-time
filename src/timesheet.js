import Adw from 'gi://Adw?version=1';
import GLib from 'gi://GLib';
import { TimesheetWindow } from './timesheetWindow.js';

// Only the launcher runs anything, so process-identity setup belongs here,
// not in timesheetWindow.js: that module must only define things, since
// make check loads it by import.
GLib.set_prgname('screen-time-timesheet');

const app = new Adw.Application({
    application_id: 'org.gnome.Shell.Extensions.ScreenTime.Timesheet',
});

// No NON_UNIQUE flag, so a second launch remote-activates this instance over
// D-Bus and exits; activate then just raises the window it already has.
app.connect('activate', () => {
    if (!app.active_window)
        new TimesheetWindow(app);
    app.active_window.present();
});

app.run([]);
