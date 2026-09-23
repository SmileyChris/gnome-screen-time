import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Slider } from 'resource:///org/gnome/shell/ui/slider.js';
import { formatTime } from './formatTime.js';
import { ROW_W, DIM_OPACITY, makeUsageBar } from './usageBar.js';

// Pixels of indent per nesting level. The bar shrinks by the same amount so
// every level's right edge stays aligned.
export const INDENT = 12;
// Each press of the "+" in edit mode raises the slider's ceiling by this much.
export const EDIT_STEP_SECONDS = 30 * 60;

const ARROW_CLOSED = ' ▸';
const ARROW_OPEN = ' ▾';

function pctOf(part, whole) {
    return whole > 0 ? Math.round(part / whole * 100) : 0;
}

function menuItem() {
    let item = new PopupMenu.PopupBaseMenuItem({activate: false});
    item.track_hover = false;
    item.style = 'padding: 0;';
    return item;
}

// Mutter 47+ dropped ClutterClickAction, so a long press is a press that
// survives the Shell's long-press duration without a release or the pointer
// leaving. Short clicks still reach whatever else handles them, so an
// expandable row keeps its toggle; callers that must ignore the release
// that ends a long press check the returned state's `pressed` flag.
function longPressMs() {
    try {
        return Clutter.Settings.get_default().long_press_duration || 500;
    } catch {
        return 500;
    }
}

function addLongPress(actor, onLongPress) {
    let state = { pressed: false };
    let timer = 0;
    let cancel = () => {
        if (timer) {
            GLib.source_remove(timer);
            timer = 0;
        }
        return Clutter.EVENT_PROPAGATE;
    };
    actor.reactive = true;
    actor.connect('button-press-event', (a, event) => {
        if (event.get_button() !== 1)
            return Clutter.EVENT_PROPAGATE;
        cancel();
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, longPressMs(), () => {
            timer = 0;
            state.pressed = true;
            onLongPress();
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('button-release-event', cancel);
    actor.connect('leave-event', cancel);
    actor.connect('destroy', cancel);
    return state;
}

// Name, "time · pct%" and a bar, wrapped in a non-activating menu item.
// `arrow` is an optional St.Label owned by an expandable row.
// `pct` is what the label shows (share of the parent); `barPct`, when given,
// is what the bar draws (share of the largest sibling in that display mode).
function buildRow({ name, seconds, pct, barPct = pct, color, depth = 0, dim = false }, arrow) {
    let item = menuItem();

    let indent = depth * INDENT;
    let row = new St.BoxLayout({
        vertical: true,
        // St's `width` is the content box, so the row narrows by the indent
        // and every level's right edge lands in the same place.
        style: `padding: 4px 10px 4px ${10 + indent}px; width: ${ROW_W - indent}px;`,
    });

    let topRow = new St.BoxLayout();
    topRow.add_child(new St.Label({
        text: name,
        opacity: dim ? DIM_OPACITY : 255,
        style: 'font-size: 11px; font-weight: 500;',
    }));
    // The disclosure arrow sits beside the name, where the eye lands first.
    if (arrow)
        topRow.add_child(arrow);
    topRow.add_child(new St.BoxLayout({x_expand: true}));
    let valueLabel = new St.Label({
        text: formatTime(seconds) + ' · ' + pct + '%',
        opacity: DIM_OPACITY,
        style: 'font-size: 10px;',
    });
    topRow.add_child(valueLabel);
    row.add_child(topRow);

    // The track spans the row's content box, so a 100% bar reaches the
    // right edge of the value label above it.
    let barW = ROW_W - indent;
    let bar = makeUsageBar(Math.round(barW * Math.min(barPct, 100) / 100), color, barW);
    row.add_child(bar);
    return { item, row, topRow, valueLabel, bar, barW, indent };
}

function smallButton(label, onClick) {
    let btn = new St.Button({
        label,
        style_class: 'button',
        style: 'font-size: 10px; padding: 2px 10px; margin-left: 6px;',
        can_focus: true,
    });
    btn.connect('clicked', onClick);
    return btn;
}

// The "Rename" button on a level-1 row's long-press line. Clicking swaps it
// for an entry showing the tracked name as its hint; `commit()` (or Enter)
// hands the trimmed text to `onRename`, where empty restores the tracked
// name. `reset()` puts the button back. `onEditing(bool)` reports the swap
// so the row can change the buttons beside it.
const ENTER_KEYS = [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter];

function renameControl({ name, renamed, trackedName, onRename }, onEditing = () => {}) {
    let box = new St.BoxLayout();
    let entry = null;
    let control = {
        actor: box,
        // The name typed so far, or null when the button is showing.
        get pending() {
            return entry ? entry.text.trim() : null;
        },
        commit() {
            onRename(control.pending);
        },
        reset() {
            if (!entry)
                return;
            box.replace_child(entry, button);
            entry = null;
            onEditing(false);
        },
    };
    let button = smallButton(renamed ? 'Renamed' : 'Rename', () => {
        entry = new St.Entry({
            text: name,
            hint_text: trackedName,
            can_focus: true,
            style: 'font-size: 10px; width: 150px;',
        });
        // ClutterText's `activate` never fires here (the input method takes
        // the key round trip), so Enter is caught directly.
        entry.clutter_text.connect('key-press-event', (_a, event) => {
            if (!ENTER_KEYS.includes(event.get_key_symbol()))
                return Clutter.EVENT_PROPAGATE;
            control.commit();
            return Clutter.EVENT_STOP;
        });
        box.replace_child(button, entry);
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, -1);
        onEditing(true);
    });
    button.style += ' margin-left: 0;';
    box.add_child(button);
    return control;
}

// A leaf row. Options beyond buildRow's:
//   editable: { parentTotal, onSave(seconds) } enables long-press editing.
//   The row then owns a second, hidden menu item (`extraItems`) holding the
//   Save and Cancel buttons; the caller adds it right after `item`.
//   suppressed: start hidden even when the parent expands, until reveal().
//   rename: { renamed, trackedName, onRename(name) } adds a Rename button
//   to that line (level-1 apps only).
// `collapse` exists so parents can treat every child alike; on a leaf it
// also leaves edit mode.
export function makeRow(opts) {
    let { editable = null, suppressed = false, rename = null } = opts;
    let { item, row, topRow, valueLabel, bar, barW } = buildRow(opts, null);
    item.add_child(row);

    let controlsItem = null;
    let saveButton = null;
    let editing = null;   // { box } while in edit mode
    let renamer = null;

    let leaveEdit = () => {
        if (!editing)
            return;
        row.replace_child(editing.box, bar);
        valueLabel.text = formatTime(opts.seconds) + ' · ' + opts.pct + '%';
        controlsItem.hide();
        renamer?.reset();
        saveButton.label = 'Save';
        editing = null;
    };

    let enterEdit = () => {
        if (editing || !editable)
            return;
        let current = opts.seconds;
        let max = Math.max(current, EDIT_STEP_SECONDS);
        let value = current;

        let slider = new Slider(max > 0 ? current / max : 0);
        slider.x_expand = true;
        slider.connect('notify::value', () => {
            value = Math.round(slider.value * max / 60) * 60;
            valueLabel.text = formatTime(value) + ' · ' + pctOf(value, editable.parentTotal) + '%';
            // Saving zero removes the entry, so say so on the button.
            saveButton.label = value === 0 ? 'Delete' : 'Save';
        });
        let plus = new St.Button({
            label: '+',
            style_class: 'button',
            style: 'font-size: 11px; padding: 0 8px; margin-left: 6px;',
            can_focus: true,
        });
        plus.connect('clicked', () => {
            max += EDIT_STEP_SECONDS;
            slider.value = value / max;
        });
        let box = new St.BoxLayout({ style: `width: ${barW}px; margin-top: 2px;` });
        box.add_child(slider);
        box.add_child(plus);

        row.replace_child(bar, box);
        editing = { box };
        controlsItem.show();
        editing.save = () => {
            let chosen = value;
            // Save covers a rename in progress too. Read it before
            // leaveEdit() puts the Rename button back.
            let name = renamer?.pending ?? null;
            leaveEdit();
            if (name !== null)
                rename.onRename(name);
            editable.onSave(chosen);
        };
    };

    if (editable) {
        controlsItem = menuItem();
        let controls = new St.BoxLayout({
            style: `padding: 0 10px 6px ${10 + (opts.depth ?? 0) * INDENT}px; width: ${ROW_W - (opts.depth ?? 0) * INDENT}px;`,
        });
        if (rename) {
            renamer = renameControl({ name: opts.name, ...rename });
            controls.add_child(renamer.actor);
        }
        controls.add_child(new St.BoxLayout({x_expand: true}));
        controls.add_child(smallButton('Cancel', () => leaveEdit()));
        saveButton = smallButton('Save', () => editing?.save());
        controls.add_child(saveButton);
        controlsItem.add_child(controls);
        controlsItem.hide();

        let press = addLongPress(row, enterEdit);
        // A short click on the title line while editing cancels; the click
        // that ends the long press itself is ignored. Only the title line,
        // so releasing the slider knob or the "+" cannot cancel the edit.
        topRow.reactive = true;
        topRow.connect('button-release-event', () => {
            if (press.pressed) {
                press.pressed = false;
                return Clutter.EVENT_PROPAGATE;
            }
            if (editing)
                leaveEdit();
            return Clutter.EVENT_PROPAGATE;
        });
    }

    if (suppressed)
        item.hide();

    return {
        item,
        extraItems: controlsItem ? [controlsItem] : [],
        suppressed,
        collapse() {
            leaveEdit();
        },
        reveal() {
            this.suppressed = false;
            item.show();
        },
    };
}

// A row that shows and hides the rows handed to setChildren. Children are
// menu items the caller adds right after this one; they start hidden.
// Collapsing also collapses each child so a re-expand never reveals a stale
// open grandchild. `onLongPress`, if given, runs on a held press instead of
// the toggle; `onToggle(expanded)` reports state changes. `rename` is as for
// makeRow and needs `onDelete`, whose line it shares.
export function makeExpandableRow(opts) {
    let { onLongPress = null, onToggle = null, onDelete = null, rename = null } = opts;
    let arrow = new St.Label({
        text: ARROW_CLOSED,
        opacity: DIM_OPACITY,
        style: 'font-size: 10px;',
    });
    let { item, row } = buildRow(opts, arrow);
    let btn = new St.Button({child: row, style: 'padding: 0;'});
    item.add_child(btn);

    // Parents are not edited directly; a long press offers to delete the
    // whole subtree instead. The line lives right under the parent row and
    // hides again on collapse.
    let deleteItem = null;
    let renamer = null;
    if (onDelete) {
        deleteItem = menuItem();
        let indent = (opts.depth ?? 0) * INDENT;
        let controls = new St.BoxLayout({
            style: `padding: 0 10px 6px ${10 + indent}px; width: ${ROW_W - indent}px;`,
        });
        let deleteButton = smallButton('Delete all', () => onDelete());
        let cancelButton = smallButton('Cancel', () => renamer.reset());
        let saveButton = smallButton('Save', () => renamer.commit());
        if (rename) {
            // While the name is being edited, Cancel and Save stand in for
            // Delete all.
            renamer = renameControl({ name: opts.name, ...rename }, editing => {
                deleteButton.visible = !editing;
                cancelButton.visible = editing;
                saveButton.visible = editing;
            });
            controls.add_child(renamer.actor);
        }
        cancelButton.hide();
        saveButton.hide();
        controls.add_child(new St.BoxLayout({x_expand: true}));
        controls.add_child(deleteButton);
        controls.add_child(cancelButton);
        controls.add_child(saveButton);
        deleteItem.add_child(controls);
        deleteItem.hide();
    }

    let children = [];
    let expanded = false;
    let collapse = () => {
        expanded = false;
        arrow.text = ARROW_CLOSED;
        deleteItem?.hide();
        renamer?.reset();
        for (let c of children) {
            c.item.hide();
            for (let extra of c.extraItems ?? [])
                extra.hide();
            c.collapse();
        }
        onToggle?.(false);
    };
    let expand = () => {
        if (expanded)
            return;
        expanded = true;
        arrow.text = ARROW_OPEN;
        for (let c of children) {
            if (!c.suppressed)
                c.item.show();
        }
        onToggle?.(true);
    };

    let press = onLongPress
        ? addLongPress(row, () => {
            onLongPress();
            deleteItem?.show();
        })
        : { pressed: false };
    btn.connect('clicked', () => {
        if (press.pressed) {
            press.pressed = false;   // the release that ended a long press
            return;
        }
        if (expanded)
            collapse();
        else
            expand();
    });

    return {
        item,
        extraItems: deleteItem ? [deleteItem] : [],
        suppressed: false,
        collapse,
        expand,
        setChildren(rows) {
            children = rows;
            for (let c of rows) {
                c.item.hide();
                for (let extra of c.extraItems ?? [])
                    extra.hide();
                c.collapse();
            }
        },
    };
}
