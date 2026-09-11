import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { panelLabelText } from './panelMode.js';

export const PanelIndicator = class extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    _init() {
        super._init(0.5, 'Screen Time');

        const hbox = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });
        hbox.add_child(new St.Icon({
            icon_name: 'alarm-symbolic',
            style_class: 'system-status-icon',
        }));
        this._dot = new St.Label({
            text: '●',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'padding-left: 4px; font-size: 9px;',
            visible: false,
        });
        hbox.add_child(this._dot);
        this._label = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            // 160px comfortably fits "client" mode's common case - a short
            // client name plus an elapsed time, e.g. "Anderson & Co 3h45m"
            // - without letting an unusually long client name push every
            // other panel item along with it; anything longer ellipsizes.
            style: 'padding-left: 4px; max-width: 160px;',
        });
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        hbox.add_child(this._label);
        this.add_child(hbox);

        this._totalSeconds = 0;
        this._mode = 'screen';
        this._clock = { running: false, away: false, client: '', seconds: 0 };
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

    // The dot shows in every mode, `none` included: whether the clock is
    // running is the one thing the panel must answer without a click.
    // Hollow means away but still counting.
    _updateLabel() {
        this._dot.visible = this._clock.running;
        this._dot.text = this._clock.away ? '○' : '●';

        let text = panelLabelText(this._mode, this._totalSeconds, this._clock);
        this._label.visible = text.length > 0;
        if (this._label.visible)
            this._label.text = text;
    }
};
