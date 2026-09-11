import Gdk from 'gi://Gdk?version=4.0';
import { test, assert } from './harness.js';
import { isValidBinding } from '../src/accelerators.js';

const CTRL = Gdk.ModifierType.CONTROL_MASK;
const ALT = Gdk.ModifierType.ALT_MASK;
const SUPER = Gdk.ModifierType.SUPER_MASK;
const SHIFT = Gdk.ModifierType.SHIFT_MASK;

function refused(name, mask, keyval) {
    test(`isValidBinding: ${name} is refused`, () => {
        assert(!isValidBinding(mask, keyval), `expected ${name} to be refused`);
    });
}

function accepted(name, mask, keyval) {
    test(`isValidBinding: ${name} is accepted`, () => {
        assert(isValidBinding(mask, keyval), `expected ${name} to be accepted`);
    });
}

// Bare keys that would swallow ordinary typing, text selection or
// navigation if bound globally.
refused('a bare letter', 0, Gdk.KEY_t);
refused('a bare digit', 0, Gdk.KEY_5);
refused('a bare space', 0, Gdk.KEY_space);
refused('a bare keypad digit', 0, Gdk.KEY_KP_5);
refused('a bare Tab', 0, Gdk.KEY_Tab);
refused('a bare arrow key', 0, Gdk.KEY_Left);
refused('a bare Return', 0, Gdk.KEY_Return);

// Shift alone is no real modifier: it must be refused exactly like the bare
// key above, not treated as "has a modifier".
refused('Shift+letter', SHIFT, Gdk.KEY_t);
refused('Shift+digit', SHIFT, Gdk.KEY_5);
refused('Shift+space', SHIFT, Gdk.KEY_space);
refused('Shift+Left', SHIFT, Gdk.KEY_Left);
refused('Shift+Tab', SHIFT, Gdk.KEY_Tab);

// A modifier pressed alone (reported with no other keyval and mask 0, since
// the modifier that is about to apply is not yet reflected in `state` for
// its own key-press event) is never a usable accelerator.
refused('Ctrl alone', 0, Gdk.KEY_Control_L);
refused('Super alone', 0, Gdk.KEY_Super_L);
refused('Shift alone', 0, Gdk.KEY_Shift_L);

// Real, safe bindings.
accepted('Ctrl+Alt+T', CTRL | ALT, Gdk.KEY_t);
accepted('Super+T', SUPER, Gdk.KEY_t);
accepted('Ctrl+Shift+T', CTRL | SHIFT, Gdk.KEY_t);

// Bare function keys are a deliberate exception: GNOME's own shortcut editor
// and default media-key bindings use unmodified keys like these.
accepted('a bare F5', 0, Gdk.KEY_F5);

// Bare punctuation and symbol keys: each produces a printable character
// (Gdk.keyval_to_unicode() !== 0) and would type into whatever field has
// focus exactly like a letter would.
refused('a bare period', 0, Gdk.KEY_period);
refused('a bare comma', 0, Gdk.KEY_comma);
refused('a bare minus', 0, Gdk.KEY_minus);
refused('a bare slash', 0, Gdk.KEY_slash);
refused('a bare semicolon', 0, Gdk.KEY_semicolon);
refused('a bare apostrophe', 0, Gdk.KEY_apostrophe);
refused('Shift+exclam (!)', SHIFT, Gdk.KEY_exclam);
refused('Shift+question (?)', SHIFT, Gdk.KEY_question);

// Bare editing keys: BackSpace and Delete happen to also fail the
// printable-character check (their C0 control codes are nonzero), but
// Insert does not (Gdk.keyval_to_unicode() returns 0 for it) - all three
// are refused via the explicit FORBIDDEN entries either way.
refused('a bare BackSpace', 0, Gdk.KEY_BackSpace);
refused('a bare Delete', 0, Gdk.KEY_Delete);
refused('a bare Insert', 0, Gdk.KEY_Insert);

// Bare non-Latin letters: the old range check (a-z/A-Z only) let every one
// of these straight through.
refused('a bare Cyrillic letter', 0, Gdk.KEY_Cyrillic_a);
refused('a bare Greek letter', 0, Gdk.KEY_Greek_alpha);
refused('a bare a-umlaut (ä)', 0, Gdk.KEY_adiaeresis);
refused('a bare e-acute (é)', 0, Gdk.KEY_eacute);

// Bare media keys are a deliberate exception, same as function keys: they
// produce no character (Gdk.keyval_to_unicode() === 0) and GNOME's default
// bindings use them unmodified.
accepted('a bare media key (AudioPlay)', 0, Gdk.KEY_AudioPlay);
