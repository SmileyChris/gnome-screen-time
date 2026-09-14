import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { panelLabelText, panelLabelDimmed } from './panelMode.js';
import { DIM_OPACITY } from './usageBar.js';

// The stopwatch ships with the extension because neither Adwaita nor common
// icon themes have one; the -symbolic name makes the Shell recolour it like
// any other panel icon. Found beside this module, so nothing has to pass the
// extension's path in.
const ICONS_DIR = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'icons',
]);
const IDLE_ICON = new Gio.ThemedIcon({ name: 'alarm-symbolic' });
const TRACKING_ICON = Gio.FileIcon.new(Gio.File.new_for_path(
    GLib.build_filenamev([ICONS_DIR, 'screen-time-tracking-symbolic.svg'])));

export const PanelIndicator = class extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init(0.5, 'Screen Time');

        const hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });
        this._icon = new St.Icon({
            gicon: IDLE_ICON,
            style_class: 'system-status-icon',
        });
        hbox.add_child(this._icon);
        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            // 160px comfortably fits "client" mode's common case - a short
            // client name plus an elapsed time, e.g. "Anderson & Co 3h45m"
            // - without letting an unusually long client name push every
            // other panel item along with it; anything longer ellipsizes.
            // The right padding keeps the text off the end of the pill.
            style: 'padding-left: 4px; padding-right: 4px; max-width: 160px;',
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        hbox.add_child(this._label);
        this.add_child(hbox);

        this._totalSeconds = 0;
        this._mode = 'screen';
        this._clock = { running: false, away: false, paused: false, client: '', seconds: 0 };
        this._updateLabel();
    }

    addToPanel(uuid) {
        Main.panel.addToStatusArea(uuid, this);
    }

    setTotal(seconds) {
        this._totalSeconds = seconds;
        this._updateLabel();
    }

    setMode(mode) {
        this._mode = mode;
        this._updateLabel();
    }

    setClock(state) {
        this._clock = state;
        this._updateLabel();
    }

    // The icon turns into a stopwatch while the clock runs, in every mode,
    // `none` included: whether the clock is running is the one thing the
    // panel must answer without a click. Dimmed means away but still
    // counting. A paused clock's total is faded.
    _updateLabel() {
        let running = this._clock.running;
        this._icon.gicon = running ? TRACKING_ICON : IDLE_ICON;
        this._icon.opacity = running && this._clock.away ? DIM_OPACITY : 255;

        let text = panelLabelText(this._mode, this._totalSeconds, this._clock);
        this._label.visible = text.length > 0;
        if (this._label.visible)
            this._label.text = text;
        this._label.opacity = panelLabelDimmed(this._mode, this._clock) ? DIM_OPACITY : 255;
    }
};
