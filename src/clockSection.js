import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { formatTime } from './formatTime.js';
import { recentClients } from './clients.js';
import { todayKeyFor } from './usageStore.js';

// Rows below the app breakdown: one per client, tap to clock in, tap the
// running one to stop. The list doubles as the readout and the control, so
// there is no separate start button.
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

            let row = new St.BoxLayout({x_expand: true, style: 'padding: 4px 12px;'});

            let dot = new St.Label({
                text: isRunning ? '●' : '○',
                style_class: isRunning ? 'clock-dot-running' : 'clock-dot-idle',
                y_align: Clutter.ActorAlign.CENTER,
                opacity: isRunning ? 255 : 0,
            });
            row.add_child(dot);

            let label = new St.Label({
                text: name, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(label);

            let secs = byClient.get(name) ?? 0;
            row.add_child(new St.Label({
                text: secs > 0 ? formatTime(secs) : '—',
                style_class: 'clock-row-time',
                y_align: Clutter.ActorAlign.CENTER,
            }));

            let btn = new St.Button({
                child: row,
                can_focus: true,
                style: 'width: 100%; padding: 0;',
            });
            btn.connect('clicked', () => {
                // Re-derived here rather than closed over `isRunning`: the
                // panel/shortcut (a later task) can change the clock while
                // the popup is still open, and a stale `true` would stop
                // whatever session is actually running instead of the
                // tapped client.
                let running = this._clock.running?.client === name;
                if (running)
                    this._clock.stop();
                else
                    this._clock.start(name);
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
