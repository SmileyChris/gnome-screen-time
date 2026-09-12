// Keeps a Timesheet draft's hours in step with the Bill control, telling a
// person's edit (which marks the hours as edited) apart from the window's own
// live refresh (which must not). GTK emits value-changed for ANY change to an
// adjustment's value, including one made by code, so a refresh blocks this
// binding's handler while it writes.
export class HoursBinding {
    constructor(adjustment, draft) {
        this._adjustment = adjustment;
        this._draft = draft;
        this._handlerId = adjustment.connect('value-changed', () => {
            draft.hours = adjustment.value;
            draft.hoursDirty = true;
        });
    }

    // Brings untouched hours up to date with a running clock. Leaves them
    // alone once the person has edited them, and while the control has focus,
    // so a tick never overwrites a value being typed.
    refresh(hours, { focused = false } = {}) {
        if (this._draft.hoursDirty || focused)
            return;
        this._adjustment.block_signal_handler(this._handlerId);
        try {
            this._adjustment.value = hours;
        } finally {
            this._adjustment.unblock_signal_handler(this._handlerId);
        }
        this._draft.hours = this._adjustment.value;
    }
}

// What Save sends: only the fields the person actually edited, so a note-only
// save never pins billedHours and an hours-only save never sends the seeded,
// unedited note. An empty object means there is nothing to save.
export function saveFields(draft, hoursValue, noteText) {
    let fields = {};
    if (draft.hoursDirty)
        fields.billedHours = Math.round(hoursValue * 100) / 100;
    if (draft.noteDirty)
        fields.description = noteText.trim();
    return fields;
}
