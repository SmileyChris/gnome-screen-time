import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { formatTime } from './formatTime.js';
import { ROW_W, DIM_OPACITY } from './usageBar.js';
import { recentClients } from './clients.js';
import { todayKeyFor } from './usageStore.js';

// Rows below the app breakdown: one per client, tap to clock in, tap the
// running one to pause it (the clock card's stop button is the only way to
// stop outright). The list doubles as the readout and the control, so there
// is no separate start button.
//
// Rebuilt from scratch inside PopupWidget._build(), exactly like
// AppTimerSection: _build() starts with menu.removeAll(), which destroys
// every item, so this section holds no item references between builds.
export class ClockSection {
    constructor(clock, settings) {
        this._clock = clock;
        this._settings = settings;
    }

    // Appends one row per client to `menu`. Returns whether it added
    // anything, so the caller knows whether to add a trailing separator.
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
        if (names.length === 0)
            return false;

        // Same rule the day total uses, so a row and the total can never
        // disagree.
        let byClient = this._clock.billedSecondsByClient(dayKey);

        for (let name of names) {
            let isRunning = this._clock.running?.client === name;
            let item = new PopupMenu.PopupBaseMenuItem({activate: false});
            item.track_hover = false;
            item.style = 'padding: 0;';

            // Laid out like the usage rows above (usageRows.js): the same
            // content width and font sizes, so the two lists line up.
            let row = new St.BoxLayout({style: `padding: 4px 10px; width: ${ROW_W}px;`});

            // Every row reserves the dot's space, so the names line up
            // whichever client is running. Purple, like the clock card.
            row.add_child(new St.Label({
                text: '●',
                opacity: isRunning ? 255 : 0,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 8px; padding-right: 6px; color: #c061cb;',
            }));

            let label = new St.Label({
                text: name,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 11px; font-weight: ${isRunning ? 700 : 500};`,
            });
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(label);

            let secs = byClient.get(name) ?? 0;
            row.add_child(new St.Label({
                text: secs > 0 ? formatTime(secs) : '—',
                opacity: DIM_OPACITY,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 10px; padding-left: 8px;',
            }));

            let btn = new St.Button({
                child: row,
                can_focus: true,
                x_expand: true,
                style_class: 'screen-time-clock-row',
            });
            btn.connect('clicked', () => {
                // Re-derived here rather than closed over `isRunning`: the
                // panel/shortcut (a later task) can change the clock while
                // the popup is still open, and a stale `true` would stop
                // whatever session is actually running instead of the
                // tapped client.
                let running = this._clock.running?.client === name;
                try {
                    if (running)
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

            item.add_child(btn);
            menu.addMenuItem(item);
        }

        return true;
    }

    destroy() {
        this._clock = null;
        this._settings = null;
    }
}
