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
        // The pause badge sits over the icon's bottom-right corner, so the
        // icon still says what the indicator is while it says "paused".
        let iconStack = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this._icon = new St.Icon({
            gicon: IDLE_ICON,
            style_class: 'system-status-icon',
        });
        iconStack.add_child(this._icon);
        this._pauseBadge = new St.Icon({
            icon_name: 'media-playback-pause-symbolic',
            icon_size: 8,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
            visible: false,
        });
        iconStack.add_child(this._pauseBadge);
        hbox.add_child(iconStack);
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
        this._trackingPaused = false;
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

    // Screen Time's own pause (paused-until), not the clock's paused client.
    setPaused(paused) {
        this._trackingPaused = paused;
        this._updateLabel();
    }

    setClock(state) {
        this._clock = state;
        this._updateLabel();
    }

    // The icon turns into a stopwatch while the clock runs, in every mode,
    // `none` included: whether the clock is running is the one thing the
    // panel must answer without a click. Dimmed means away but still
    // counting. A paused clock's total is faded. A tracking pause badges
    // whichever icon shows, and fades the screen total unless the running
    // clock's time is what the label shows.
    _updateLabel() {
        let running = this._clock.running;
        let trackingPaused = this._trackingPaused && !running;
        this._icon.gicon = running ? TRACKING_ICON : IDLE_ICON;
        this._pauseBadge.visible = this._trackingPaused;
        this._icon.opacity = running && this._clock.away ? DIM_OPACITY : 255;

        let text = panelLabelText(this._mode, this._totalSeconds, this._clock);
        this._label.visible = text.length > 0;
        if (this._label.visible)
            this._label.text = text;
        this._label.opacity = panelLabelDimmed(this._mode, this._clock) || trackingPaused
            ? DIM_OPACITY : 255;
    }
};
