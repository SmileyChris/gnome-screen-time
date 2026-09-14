import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk?version=4.0';
import { isValidBinding } from './accelerators.js';

// Gtk.ShortcutLabel is deprecated since GTK 4.18 in favour of
// Adw.ShortcutLabel, which only exists from libadwaita 1.8 (GNOME 49).
// Both take the same accelerator and disabled-text properties, so GNOME 47
// and 48 fall back to the GTK one.
const ShortcutLabel = Adw.ShortcutLabel ?? Gtk.ShortcutLabel;

export const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    constructor(settings, key, title, subtitle) {
        super({ title, subtitle, activatable: true });
        this._settings = settings;
        this._key = key;
        this._editor = null;

        this._label = new ShortcutLabel({
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
        // No hide_on_close: an editor that is only ever hidden, never
        // destroyed, leaks a live window and key controller on every
        // cancel. closeEditor() below is the one path that tears it down,
        // reached from every exit (save, clear, Escape, and the window
        // manager's own close request), so there is exactly one place that
        // can double-run; the guard makes that harmless.
        let editor = new Adw.Window({
            modal: true,
            transient_for: this.get_root(),
            width_request: 400,
            height_request: 200,
            content: new Adw.StatusPage({
                title: 'Press a shortcut',
                description: 'Backspace clears it. Escape cancels.',
            }),
        });
        this._editor = editor;

        let closed = false;
        let closeEditor = () => {
            if (closed)
                return;
            closed = true;
            editor.destroy();
            if (this._editor === editor)
                this._editor = null;
        };

        editor.add_controller(controller);
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            let mask = state & Gtk.accelerator_get_default_mod_mask();
            mask &= ~Gdk.ModifierType.LOCK_MASK;

            // Escape always cancels, whatever modifiers happen to be held -
            // otherwise Shift+Escape would fall through and get bound.
            if (keyval === Gdk.KEY_Escape) {
                closeEditor();
                return Gdk.EVENT_STOP;
            }
            if (keyval === Gdk.KEY_BackSpace) {
                this._save('');
                closeEditor();
                return Gdk.EVENT_STOP;
            }
            if (!isValidBinding(mask, keyval))
                return Gdk.EVENT_STOP;

            this._save(Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask));
            closeEditor();
            return Gdk.EVENT_STOP;
        });
        // Covers every other way the window can end, e.g. the compositor's
        // own close affordance, so an editor closed that way is destroyed
        // too rather than merely hidden.
        editor.connect('close-request', () => {
            closeEditor();
            return false;
        });
        editor.present();
    }

    _save(accel) {
        this._settings.set_strv(this._key, accel.length > 0 ? [accel] : []);
        this._sync();
    }
});
