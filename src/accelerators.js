import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

// Keys that must never be bound alone, ported from GNOME Control Center's
// keyboard-shortcuts panel: binding one of these with no modifier makes the
// desktop unusable and there is no way back except gsettings reset. Each
// plain-keysym navigation key is paired with its keypad duplicate (the
// keysym a numlock-off keypad press actually generates), since a raw keycode
// check on the plain keysym alone lets the keypad equivalent straight
// through.
const FORBIDDEN = [
    Gdk.KEY_Home, Gdk.KEY_Left, Gdk.KEY_Up, Gdk.KEY_Right, Gdk.KEY_Down,
    Gdk.KEY_Page_Up, Gdk.KEY_Page_Down, Gdk.KEY_End, Gdk.KEY_Tab,
    Gdk.KEY_KP_Enter, Gdk.KEY_Return, Gdk.KEY_Mode_switch,
    Gdk.KEY_KP_Home, Gdk.KEY_KP_Left, Gdk.KEY_KP_Up, Gdk.KEY_KP_Right,
    Gdk.KEY_KP_Down, Gdk.KEY_KP_Page_Up, Gdk.KEY_KP_Page_Down, Gdk.KEY_KP_End,
    Gdk.KEY_KP_Tab,
];

// Letters, digits (both rows and keypad), space and the FORBIDDEN set above
// are unsafe to bind with no real modifier: typing them, selecting text, or
// navigating a text field would instead fire the shortcut.
function isUnsafeUnmodified(keyval) {
    return (keyval >= Gdk.KEY_a && keyval <= Gdk.KEY_z) ||
           (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) ||
           (keyval >= Gdk.KEY_0 && keyval <= Gdk.KEY_9) ||
           (keyval >= Gdk.KEY_KP_0 && keyval <= Gdk.KEY_KP_9) ||
           keyval === Gdk.KEY_space ||
           FORBIDDEN.includes(keyval);
}

// Whether `mask` + `keyval` is safe to register as a global shortcut. Two
// gates:
//
// 1. Shift alone provides no real protection against typing text, selecting
//    it, or navigating a field, so it is treated exactly like no modifier at
//    all for the unsafe-unmodified set above (Shift+letter, Shift+digit,
//    Shift+space, Shift+Tab, Shift+arrows and friends are all refused here).
// 2. A pressed-alone modifier key (Ctrl, Shift, Alt, Super, ...) is never a
//    usable accelerator on its own; GTK's own accelerator_valid() already
//    knows this, so it is used as a second, independent gate rather than
//    hand-listing every modifier keysym.
//
// Bare function keys (F5, ...) and bare media keys are deliberately left
// valid: GNOME's own shortcut editor and default media-key bindings use
// unmodified keys like these legitimately.
export function isValidBinding(mask, keyval) {
    let bare = mask === 0 || mask === Gdk.ModifierType.SHIFT_MASK;
    if (bare && isUnsafeUnmodified(keyval))
        return false;
    return Gtk.accelerator_valid(keyval, mask);
}
