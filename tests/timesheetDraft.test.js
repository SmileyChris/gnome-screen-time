import Gtk from 'gi://Gtk?version=4.0';
import { test, assertEqual } from './harness.js';
import { HoursBinding, saveFields } from '../src/timesheetDraft.js';

// A real Gtk.Adjustment, not a fake: the bug came from how GTK emits
// value-changed when code sets a value, so only GTK's own emission can catch
// it. An Adjustment needs no display, unlike the SpinButton that wraps it.
function billControl(hours) {
    return new Gtk.Adjustment({ lower: 0, upper: 999, step_increment: 0.25, value: hours });
}

function cleanDraft(hours) {
    return { note: '', hours, noteDirty: false, hoursDirty: false };
}

test('HoursBinding: a person changing the hours marks the draft dirty', () => {
    let draft = cleanDraft(1);
    let adjustment = billControl(1);
    new HoursBinding(adjustment, draft);
    adjustment.value = 2.5;   // what a typed value or a bump button does
    assertEqual([draft.hours, draft.hoursDirty], [2.5, true]);
});

test('HoursBinding: a live refresh updates the hours without marking them edited', () => {
    let draft = cleanDraft(1);
    let adjustment = billControl(1);
    let binding = new HoursBinding(adjustment, draft);
    binding.refresh(1.75);
    assertEqual([adjustment.value, draft.hours, draft.hoursDirty], [1.75, 1.75, false]);
});

test('HoursBinding: a refresh leaves hours the person has edited alone', () => {
    let draft = cleanDraft(1);
    let adjustment = billControl(1);
    let binding = new HoursBinding(adjustment, draft);
    adjustment.value = 2.5;
    binding.refresh(3);
    assertEqual([adjustment.value, draft.hours, draft.hoursDirty], [2.5, 2.5, true]);
});

test('HoursBinding: a refresh leaves the control alone while it has focus', () => {
    let draft = cleanDraft(1);
    let adjustment = billControl(1);
    let binding = new HoursBinding(adjustment, draft);
    binding.refresh(3, { focused: true });
    assertEqual([adjustment.value, draft.hours, draft.hoursDirty], [1, 1, false]);
});

test('HoursBinding: an edit after a refresh still counts as an edit', () => {
    let draft = cleanDraft(1);
    let adjustment = billControl(1);
    let binding = new HoursBinding(adjustment, draft);
    binding.refresh(1.75);
    adjustment.value = 4;
    assertEqual([draft.hours, draft.hoursDirty], [4, true]);
});

test('saveFields: a note-only save after a live refresh sends only the note', () => {
    // The reported bug: expand a running session, let the clock tick, type a
    // note, press Save. The hours must not be pinned as billedHours.
    let draft = cleanDraft(1);
    let adjustment = billControl(1);
    new HoursBinding(adjustment, draft).refresh(2.25);
    draft.note = ' invoicing setup ';
    draft.noteDirty = true;
    assertEqual(saveFields(draft, adjustment.value, draft.note),
        { description: 'invoicing setup' });
});

test('saveFields: a save with no edits after a live refresh sends nothing', () => {
    let draft = cleanDraft(1);
    let adjustment = billControl(1);
    new HoursBinding(adjustment, draft).refresh(2.25);
    assertEqual(saveFields(draft, adjustment.value, draft.note), {});
});

test('saveFields: an hours-only edit sends the hours, not the unedited note', () => {
    // The note is seeded with activity names; sending it unedited would put
    // repository names and hostnames on an invoice.
    let draft = cleanDraft(1);
    draft.note = 'django-countries; lab';
    let adjustment = billControl(1);
    new HoursBinding(adjustment, draft);
    adjustment.value = 1.25;
    assertEqual(saveFields(draft, adjustment.value, draft.note), { billedHours: 1.25 });
});
