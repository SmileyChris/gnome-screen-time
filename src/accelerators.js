import Gdk from 'gi://Gdk?version=4.0';
import Gtk from 'gi://Gtk?version=4.0';

// Keys that must never be bound alone, ported from GNOME Control Center's
// keyboard-shortcuts panel: binding one of these with no modifier makes the
// desktop unusable and there is no way back except gsettings reset. Each
// plain-keysym navigation key is paired with its keypad duplicate (the
// keysym a numlock-off keypad press actually generates), since a raw keycode
// check on the plain keysym alone lets the keypad equivalent straight
// through. BackSpace and Delete also happen to fail the printable-character
// check below on their own (Gdk.keyval_to_unicode() returns their C0
// control code, which is nonzero) - listed explicitly anyway, alongside
// Insert (which returns 0 and is genuinely not caught otherwise), rather
// than depend on that coincidence holding across GDK versions.
const FORBIDDEN = [
    Gdk.KEY_Home, Gdk.KEY_Left, Gdk.KEY_Up, Gdk.KEY_Right, Gdk.KEY_Down,
    Gdk.KEY_Page_Up, Gdk.KEY_Page_Down, Gdk.KEY_End, Gdk.KEY_Tab,
    Gdk.KEY_KP_Enter, Gdk.KEY_Return, Gdk.KEY_Mode_switch,
    Gdk.KEY_KP_Home, Gdk.KEY_KP_Left, Gdk.KEY_KP_Up, Gdk.KEY_KP_Right,
    Gdk.KEY_KP_Down, Gdk.KEY_KP_Page_Up, Gdk.KEY_KP_Page_Down, Gdk.KEY_KP_End,
    Gdk.KEY_KP_Tab, Gdk.KEY_BackSpace, Gdk.KEY_Delete, Gdk.KEY_Insert,
];

// Anything that produces a printable character - letters in any script (not
// just a-z/A-Z: Cyrillic, Greek, ä, é and friends all type into whatever
// field has focus exactly like a Latin letter does), digits (both rows and
// keypad), space, and ordinary punctuation/symbols (`.` `,` `-` `/` `;` `'`
// `!` `?` and the rest) - plus the FORBIDDEN navigation/editing set above,
// which produce no character of their own but are just as unsafe bare. Using
// Gdk.keyval_to_unicode() here, rather than hand-listing ranges the way an
// earlier version of this function did, is what makes the non-Latin and
// punctuation cases refused at all: a keysym range check only ever covered
// the ASCII keys it was written against.
function isUnsafeUnmodified(keyval) {
    return Gdk.keyval_to_unicode(keyval) !== 0 || FORBIDDEN.includes(keyval);
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
