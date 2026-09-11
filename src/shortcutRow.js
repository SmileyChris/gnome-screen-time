import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

// Keys that must never be bound alone, ported from GNOME Control Center's
// keyboard-shortcuts panel: binding one of these with no modifier makes the
// desktop unusable and there is no way back except gsettings reset.
const FORBIDDEN = [
    Gdk.KEY_Home, Gdk.KEY_Left, Gdk.KEY_Up, Gdk.KEY_Right, Gdk.KEY_Down,
    Gdk.KEY_Page_Up, Gdk.KEY_Page_Down, Gdk.KEY_End, Gdk.KEY_Tab,
    Gdk.KEY_KP_Enter, Gdk.KEY_Return, Gdk.KEY_Mode_switch,
];

function isValidBinding(mask, keyval) {
    if (mask !== 0)
        return true;
    // No modifier: only function keys and a handful of specials are safe.
    return !((keyval >= Gdk.KEY_a && keyval <= Gdk.KEY_z) ||
             (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) ||
             (keyval >= Gdk.KEY_0 && keyval <= Gdk.KEY_9) ||
             FORBIDDEN.includes(keyval));
}

export const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    constructor(settings, key, title, subtitle) {
        super({ title, subtitle, activatable: true });
        this._settings = settings;
        this._key = key;

        this._label = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);
        this._sync();

        this.connect('activated', () => this._edit());
    }

    _sync() {
        let [accel] = this._settings.get_strv(this._key);
        this._label.accelerator = accel ?? '';
    }

    _edit() {
        let controller = new Gtk.EventControllerKey();
        this._editor = new Adw.Window({
            modal: true,
            hide_on_close: true,
            transient_for: this.get_root(),
            width_request: 400,
            height_request: 200,
            content: new Adw.StatusPage({
                title: 'Press a shortcut',
                description: 'Backspace clears it. Escape cancels.',
            }),
        });
        this._editor.add_controller(controller);
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            let mask = state & Gtk.accelerator_get_default_mod_mask();
            mask &= ~Gdk.ModifierType.LOCK_MASK;

            if (mask === 0 && keyval === Gdk.KEY_Escape) {
                this._editor.close();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace) {
                this._save('');
                return Gdk.EVENT_STOP;
            }
            if (!isValidBinding(mask, keyval))
                return Gdk.EVENT_STOP;

            this._save(Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask));
            return Gdk.EVENT_STOP;
        });
        this._editor.present();
    }

    _save(accel) {
        this._settings.set_strv(this._key, accel.length > 0 ? [accel] : []);
        this._sync();
        this._editor.destroy();
        this._editor = null;
    }
});
