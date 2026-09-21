import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { formatTime } from './formatTime.js';
import { ROW_W, DIM_OPACITY } from './usageBar.js';
import { recentClients, pausedClient } from './clients.js';
import { todayKeyFor } from './usageStore.js';

// Rows below the app breakdown: one per client, tap to clock in, tap the
// running one to pause it (the clock card's stop button is the only way to
// stop outright). The list doubles as the readout and the control, so there
// is no separate start button. An icon after a name shows what tapping that
// row does (pause the running client, resume the paused one), and a last
// "Add client…" row opens Preferences.
//
// Rebuilt from scratch inside PopupWidget._build(), exactly like
// AppTimerSection: _build() starts with menu.removeAll(), which destroys
// every item, so this section holds no item references between builds.
export class ClockSection {
    constructor(clock, settings, openPrefs) {
        this._clock = clock;
        this._settings = settings;
        this._openPrefs = openPrefs;
    }

    // Appends one row per client to `menu`, then the "Add client…" row.
    //
    // Each row is a non-activating PopupBaseMenuItem holding an St.Button:
    // a plain activating item's default 'activate' handler unconditionally
    // closes the top menu (PopupMenuBase._connectItemSignals() -> AFTER
    // handler -> itemActivated()), which would discard the very rebuild the
    // tap just triggered and give the user no in-popup confirmation that
    // they clocked in. Every other clickable row in this popup
    // (usageRows.js, appTimerSection.js) uses the same button-in-item shape
    // for the same reason.
    build(menu, rebuild) {
        let dayKey = todayKeyFor(this._settings);
        let names = recentClients(this._settings, this._clock, dayKey);

        // Same rule the day total uses, so a row and the total can never
        // disagree.
        let byClient = this._clock.billedSecondsByClient(dayKey);
        let running = this._clock.running ?? null;
        // Same rule as the clock card, so the two never disagree about which
        // client is paused.
        let paused = pausedClient(this._settings, running);

        for (let name of names) {
            let isRunning = running?.client === name;

            // Laid out like the usage rows above (usageRows.js): the same
            // padding, content width and font sizes, so the names line up
            // with the app names.
            let row = new St.BoxLayout({style: `padding: 4px 10px; width: ${ROW_W}px;`});

            let label = new St.Label({
                text: name,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 11px; font-weight: ${isRunning ? 700 : 500};`,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(label);

            // The icon shows what a tap does, like the clock card's buttons:
            // pause on the running client, play on the paused one. Purple
            // for running, like the clock card.
            if (isRunning || name === paused) {
                row.add_child(new St.Icon({
                    icon_name: isRunning ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
                    icon_size: 10,
                    opacity: isRunning ? 255 : DIM_OPACITY,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `margin-left: 5px;${isRunning ? ' color: #c061cb;' : ''}`,
                }));
            }

            // Pushes the time to the right edge. The name label does not
            // expand, so the icon stays next to the name.
            row.add_child(new St.Widget({x_expand: true}));

            let secs = byClient.get(name) ?? 0;
            row.add_child(new St.Label({
                text: secs > 0 ? formatTime(secs) : '—',
                opacity: DIM_OPACITY,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 10px; padding-left: 8px;',
            }));

            let btn = this._rowButton(menu, row);
            btn.connect('clicked', () => {
                // Re-derived here rather than closed over `isRunning`: the
                // panel/shortcut can change the clock while the popup is
                // still open, and a stale `true` would stop whatever session
                // is actually running instead of the tapped client.
                let nowRunning = this._clock.running?.client === name;
                try {
                    if (nowRunning)
                        this._clock.stop();
                    else
                        this._clock.start(name);
                } catch (e) {
                    // start()/stop() throw only when the system clock is
                    // out of range; there is no toast in the popup, so log
                    // and leave last-client/the rebuild alone rather than
                    // recording a client switch that never actually
                    // happened.
                    console.error(`[ScreenTime] clock tap failed: ${e.message}`);
                    return;
                }
                this._settings.set_string('last-client', name);
                rebuild();
            });
        }

        // Always the last row, even with no clients at all, so a fresh
        // install shows where clients come from. Clients are only created in
        // Preferences (see prefs.js's _addClientsGroup), because the popup
        // cannot take text input sanely.
        let addRow = new St.BoxLayout({style: `padding: 4px 10px; width: ${ROW_W}px;`});
        addRow.add_child(new St.Label({
            text: 'Add client…',
            opacity: DIM_OPACITY,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; font-weight: 500;',
        }));
        this._rowButton(menu, addRow).connect('clicked', () => {
            // Asks Preferences to focus its "Add a client" field (see
            // prefs.js's _addClientsGroup).
            this._settings.set_string('prefs-focus', 'add-client');
            this._openPrefs?.();
        });
    }

    // Wraps `row` in the button-in-item shape described above build() and
    // appends it to `menu`. Returns the button for the caller to connect.
    _rowButton(menu, row) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let btn = new St.Button({
            child: row,
            can_focus: true,
            x_expand: true,
            style_class: 'screen-time-clock-row',
        });
        item.add_child(btn);
        menu.addMenuItem(item);
        return btn;
    }

    destroy() {
        this._clock = null;
        this._settings = null;
        this._openPrefs = null;
    }
}
