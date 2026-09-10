import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { STORE_FILE, knownAppsFromData, dateKey } from './usageStore.js';
import { formatTime } from './formatTime.js';
import { getAppLimits, setAppLimit, removeAppLimit } from './appLimits.js';

const HISTORY_DAYS = 7;
const CHART_HEIGHT = 110;
// Same accent blue the popup uses for the largest app, so the two views read
// as one product.
const BAR_RGB = [0x35 / 255, 0x84 / 255, 0xe4 / 255];

// Sync read is fine here: prefs runs in its own process, not the compositor.
function loadUsageData() {
    let file = Gio.File.new_for_path(STORE_FILE);
    if (!file.query_exists(null))
        return {};
    try {
        let [ok, contents] = file.load_contents(null);
        return ok ? JSON.parse(new TextDecoder().decode(contents)) : {};
    } catch (e) {
        console.error(`[ScreenTime] history load error: ${e.message}`);
        return {};
    }
}

// Oldest first, so the chart reads left-to-right ending at today.
function lastDays(data, count, startHour) {
    let now = GLib.DateTime.new_now_local();
    let days = [];
    for (let i = count - 1; i >= 0; i--) {
        let day = now.add_days(-i);
        let seconds = Object.values(data[dateKey(day, startHour)] ?? {})
            .reduce((s, a) => s + a.seconds, 0);
        days.push({
            label: i === 0 ? 'Today' : day.format('%a'),
            seconds,
        });
    }
    return days;
}

function buildHistogram(days) {
    let box = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        css_classes: ['card'],
        margin_top: 8,
    });

    let area = new Gtk.DrawingArea({
        content_height: CHART_HEIGHT,
        hexpand: true,
        margin_top: 12,
        margin_start: 12,
        margin_end: 12,
    });
    area.set_draw_func((widget, cr, width, height) => {
        let max = Math.max(...days.map(d => d.seconds), 1);
        let slot = width / days.length;
        let barW = Math.min(slot * 0.55, 36);

        days.forEach((d, i) => {
            let x = i * slot + (slot - barW) / 2;

            // Faint full-height track keeps empty days visible.
            cr.setSourceRGBA(0.5, 0.5, 0.5, 0.15);
            cr.rectangle(x, 0, barW, height);
            cr.fill();

            if (d.seconds > 0) {
                let h = Math.max((d.seconds / max) * height, 2);
                cr.setSourceRGBA(BAR_RGB[0], BAR_RGB[1], BAR_RGB[2], 1);
                cr.rectangle(x, height - h, barW, h);
                cr.fill();
            }
        });
        cr.$dispose();
    });
    box.append(area);

    let labels = new Gtk.Box({
        homogeneous: true,
        margin_start: 12,
        margin_end: 12,
        margin_bottom: 12,
    });
    for (let d of days) {
        let cell = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            halign: Gtk.Align.CENTER,
        });
        cell.append(new Gtk.Label({label: d.label, css_classes: ['caption']}));
        cell.append(new Gtk.Label({
            label: d.seconds > 0 ? formatTime(d.seconds) : '-',
            css_classes: ['caption', 'dim-label'],
        }));
        labels.append(cell);
    }
    box.append(labels);

    return box;
}

export default class ScreenTimePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const data = loadUsageData();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const panelGroup = new Adw.PreferencesGroup({title: 'Panel'});
        page.add(panelGroup);

        const showTotalRow = new Adw.SwitchRow({
            title: 'Show total time in panel',
            subtitle: 'Off shows only the icon.',
        });
        settings.bind('show-total-in-panel', showTotalRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        panelGroup.add(showTotalRow);

        const intervalGroup = new Adw.PreferencesGroup({title: 'Tracking'});
        page.add(intervalGroup);

        const intervalRow = new Adw.SpinRow({
            title: 'Max Interval',
            subtitle: 'Maximum seconds between focus events before capping.',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 3600,
                step_increment: 10,
            }),
            value: settings.get_int('max-interval'),
            snap_to_ticks: true,
        });
        settings.bind('max-interval', intervalRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        intervalGroup.add(intervalRow);

        // Stored in seconds like the other tracking keys, shown in minutes.
        const idleRow = new Adw.SpinRow({
            title: 'Idle Timeout',
            subtitle: 'Stop counting after this many minutes without keyboard or mouse input. 0 = never.',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 120,
                step_increment: 1,
            }),
            value: Math.round(settings.get_int('idle-timeout') / 60),
            snap_to_ticks: true,
        });
        idleRow.connect('notify::value', () => {
            const seconds = idleRow.value * 60;
            if (settings.get_int('idle-timeout') !== seconds)
                settings.set_int('idle-timeout', seconds);
        });
        settings.connect('changed::idle-timeout', () => {
            const minutes = Math.round(settings.get_int('idle-timeout') / 60);
            if (idleRow.value !== minutes)
                idleRow.value = minutes;
        });
        intervalGroup.add(idleRow);

        const dayStartRow = new Adw.SpinRow({
            title: 'Day Starts At',
            subtitle: 'Hour a new day begins. 4 keeps work after midnight on the previous day.',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 23,
                step_increment: 1,
            }),
            value: settings.get_int('day-start-hour'),
            snap_to_ticks: true,
        });
        settings.bind('day-start-hour', dayStartRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        intervalGroup.add(dayStartRow);

        this._addCompanionsGroup(page, window);

        this._addLimitsGroup(page, settings, data);

        const retentionGroup = new Adw.PreferencesGroup({title: 'Data Retention'});
        page.add(retentionGroup);

        const retentionRow = new Adw.SpinRow({
            title: 'Retention Days',
            subtitle: 'Number of days to keep usage data. 0 = keep forever.',
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 365,
                step_increment: 1,
            }),
            value: settings.get_int('retention-days'),
            snap_to_ticks: true,
        });
        settings.bind('retention-days', retentionRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        retentionGroup.add(retentionRow);

        const historyGroup = new Adw.PreferencesGroup({
            title: 'History',
            description: `Total screen time over the last ${HISTORY_DAYS} days.`,
        });
        page.add(historyGroup);
        historyGroup.add(buildHistogram(
            lastDays(data, HISTORY_DAYS, settings.get_int('day-start-hour'))));

        const purgeRow = new Adw.ActionRow({
            title: `Delete data older than ${HISTORY_DAYS} days`,
            subtitle: 'Removes all tracked history beyond the last week. This cannot be undone.',
        });
        const purgeButton = new Gtk.Button({
            label: 'Delete',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        purgeButton.connect('clicked', () => {
            settings.set_int('purge-requested', GLib.DateTime.new_now_local().to_unix());
        });
        purgeRow.add_suffix(purgeButton);
        historyGroup.add(purgeRow);

        window.set_focus(null);
    }

    // Live status of the browser companions, read from the running Shell
    // extension over D-Bus and refreshed while the window is open. Only
    // browsers that are installed here or currently connected get a row; a
    // not-connected one expands into the install steps for that browser.
    _addCompanionsGroup(page, window) {
        const BROWSERS = {
            brave: {
                name: 'Brave', appId: 'brave-browser.desktop',
                hostsDir: '.config/BraveSoftware/Brave-Browser/NativeMessagingHosts',
                steps: dist => `Open brave://extensions, turn on Developer mode, choose Load unpacked and pick ${dist}/webext-brave.`,
            },
            chrome: {
                name: 'Google Chrome', appId: 'google-chrome.desktop',
                hostsDir: '.config/google-chrome/NativeMessagingHosts',
                steps: dist => `Open chrome://extensions, turn on Developer mode, choose Load unpacked and pick ${dist}/webext-chrome.`,
            },
            firefox: {
                name: 'Firefox', appId: 'firefox.desktop',
                hostsDir: '.mozilla/native-messaging-hosts',
                steps: dist => `Open about:debugging#/runtime/this-firefox, choose Load Temporary Add-on and pick ${dist}/webext-firefox/manifest.json (or install ${dist}/screen-time-firefox.xpi in a build that allows unsigned add-ons).`,
            },
            zen: {
                name: 'Zen Browser', appId: 'zen.desktop',
                hostsDir: '.mozilla/native-messaging-hosts',
                steps: dist => `Open about:debugging#/runtime/this-firefox, choose Load Temporary Add-on and pick ${dist}/webext-zen/manifest.json (or install ${dist}/screen-time-zen.xpi with xpinstall.signatures.required set to false).`,
            },
        };
        const HOST_MANIFEST = 'org.gnome.shell.extensions.screen_time.json';

        const group = new Adw.PreferencesGroup({
            title: 'Browser Companions',
            description: 'Break browser time down by site with the companion extension.',
        });
        page.add(group);

        const installed = id => GioUnix.DesktopAppInfo.new(BROWSERS[id].appId) !== null;

        // The host manifest doubles as the pointer to the checkout, which is
        // where the built extension directories live.
        const setupText = id => {
            const file = Gio.File.new_for_path(GLib.build_filenamev(
                [GLib.get_home_dir(), BROWSERS[id].hostsDir, HOST_MANIFEST]));
            let hostPath = null;
            try {
                const [, bytes] = file.load_contents(null);
                hostPath = JSON.parse(new TextDecoder().decode(bytes)).path;
            } catch (e) {
                return 'Run make companion-install in the gnome-screen-time checkout first.';
            }
            const repo = GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(hostPath)));
            return BROWSERS[id].steps(GLib.build_filenamev([repo, 'dist']));
        };

        // Connected browsers get their own row. Everything installed but not
        // connected shares one collapsed expander so the group stays short.
        const connectedRows = new Map();   // id -> Adw.ActionRow
        let setupRow = null;               // Adw.ExpanderRow
        let setupIds = '';                 // ids currently inside it, for cheap diffing
        let emptyRow = null;

        const syncConnected = (id, subtitle) => {
            let row = connectedRows.get(id);
            if (!row) {
                row = new Adw.ActionRow({title: BROWSERS[id].name});
                group.add(row);
                connectedRows.set(id, row);
            }
            row.subtitle = subtitle;
        };
        const syncSetup = ids => {
            const key = ids.join(',');
            if (key === setupIds)
                return;
            setupIds = key;
            if (setupRow) {
                group.remove(setupRow);
                setupRow = null;
            }
            if (ids.length === 0)
                return;
            setupRow = new Adw.ExpanderRow({
                title: 'Not connected',
                subtitle: ids.map(id => BROWSERS[id].name).join(', '),
            });
            for (const id of ids) {
                const body = new Adw.ActionRow({title: BROWSERS[id].name, subtitle: setupText(id)});
                body.subtitle_lines = 0;
                setupRow.add_row(body);
            }
            group.add(setupRow);
        };

        const render = list => {
            const connected = new Set();
            const notConnected = [];
            for (const [id, host, isConnected, focused] of list) {
                if (!BROWSERS[id] || !(isConnected || installed(id)))
                    continue;
                if (!isConnected) {
                    notConnected.push(id);
                    continue;
                }
                connected.add(id);
                if (!host)
                    syncConnected(id, 'Connected, no web page in the active tab');
                else
                    syncConnected(id, focused ? `Connected, on ${host}` : `Connected, on ${host} (window not focused)`);
            }
            for (const id of [...connectedRows.keys()]) {
                if (!connected.has(id)) {
                    group.remove(connectedRows.get(id));
                    connectedRows.delete(id);
                }
            }
            syncSetup(notConnected);
            const any = connected.size + notConnected.length > 0;
            if (!any && !emptyRow) {
                emptyRow = new Adw.ActionRow({title: 'No supported browser found', subtitle: 'Brave, Google Chrome, Firefox and Zen are supported.'});
                group.add(emptyRow);
            } else if (any && emptyRow) {
                group.remove(emptyRow);
                emptyRow = null;
            }
        };

        const refresh = () => {
            Gio.DBus.session.call(
                'org.gnome.Shell', '/org/gnome/Shell/Extensions/ScreenTime',
                'org.gnome.Shell.Extensions.ScreenTime', 'GetCompanions',
                null, new GLib.VariantType('(a(ssbb))'), Gio.DBusCallFlags.NONE, 1000, null,
                (conn, res) => {
                    try {
                        const [list] = conn.call_finish(res).deepUnpack();
                        render(list);
                    } catch (e) {
                        // Extension not running: show installed browsers as not connected.
                        render(Object.keys(BROWSERS).map(id => [id, '', false, false]));
                    }
                });
        };
        refresh();
        const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            refresh();
            return GLib.SOURCE_CONTINUE;
        });
        window.connect('close-request', () => {
            GLib.source_remove(timer);
            return false;
        });
    }

    _addLimitsGroup(page, settings, data) {
        const limitsGroup = new Adw.PreferencesGroup({
            title: 'App Time Limits',
            description: 'Get notified once when an app crosses its daily limit.',
        });
        page.add(limitsGroup);

        // Only apps you've actually used can be picked, not a full system app scan.
        const knownApps = knownAppsFromData(data);
        const appIds = [...knownApps.keys()].sort(
            (a, b) => knownApps.get(a).localeCompare(knownApps.get(b)));

        const limitRows = new Map(); // appId -> Adw.ActionRow

        const addLimitRow = (appId, minutes) => {
            let row = new Adw.ActionRow({
                title: knownApps.get(appId) ?? appId,
                subtitle: `${minutes} min/day`,
            });
            let removeButton = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            removeButton.connect('clicked', () => {
                removeAppLimit(settings, appId);
                limitsGroup.remove(row);
                limitRows.delete(appId);
            });
            row.add_suffix(removeButton);
            limitsGroup.add(row);
            limitRows.set(appId, row);
        };

        // Listed even if the app dropped out of retained history: the limit is
        // still enforced, so it must stay visible and removable.
        let limits = getAppLimits(settings);
        for (let [appId, minutes] of Object.entries(limits))
            addLimitRow(appId, minutes);

        if (appIds.length === 0) {
            limitsGroup.add(new Adw.ActionRow({
                title: 'No tracked apps yet',
                subtitle: 'Use the computer a bit, then come back to set limits.',
            }));
            return;
        }

        const addRow = new Adw.ActionRow({title: 'Add a limit'});
        const appDropDown = new Gtk.DropDown({
            model: Gtk.StringList.new(appIds.map(id => knownApps.get(id))),
            valign: Gtk.Align.CENTER,
        });
        const minutesSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({lower: 1, upper: 1440, step_increment: 5}),
            value: 30,
            valign: Gtk.Align.CENTER,
        });
        const addButton = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER});
        addButton.connect('clicked', () => {
            let appId = appIds[appDropDown.selected];
            let minutes = minutesSpin.get_value_as_int();
            setAppLimit(settings, appId, minutes);
            if (limitRows.has(appId))
                limitsGroup.remove(limitRows.get(appId));
            addLimitRow(appId, minutes);
        });
        addRow.add_suffix(appDropDown);
        addRow.add_suffix(minutesSpin);
        addRow.add_suffix(addButton);
        limitsGroup.add(addRow);
    }
}
