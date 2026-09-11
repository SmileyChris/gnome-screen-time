import { test, assertEqual } from './harness.js';
import { EXTERNAL_ID_PREFIX, mergeSessions, toCSV, toJSON } from '../src/timeExport.js';

const CLIENTS = [
    { name: 'ACME', active: true, billable: true },
    { name: 'BETA', active: true, billable: true },
    { name: 'Self', active: true, billable: false },
    { name: 'A:B', active: true, billable: true },
];

function session(over) {
    return {
        id: 'x', client: 'ACME', dayKey: '2026-09-11',
        startMs: 0, endMs: 3600000, billedHours: null,
        description: '', exportedAt: null, ...over,
    };
}

test('mergeSessions: one session becomes one row', () => {
    let rows = mergeSessions([session({ description: 'invoicing setup' })], CLIENTS);
    assertEqual(rows, [{
        external_id: 'screen-time:ACME:2026-09-11',
        client: 'ACME', date: '2026-09-11', hours: 1, description: 'invoicing setup',
    }]);
});

test('mergeSessions: same client same day merges, notes joined', () => {
    let rows = mergeSessions([
        session({ id: 'a', description: 'django-countries' }),
        session({ id: 'b', endMs: 1800000, description: 'invoicing setup' }),
    ], CLIENTS);
    assertEqual(rows.length, 1);
    assertEqual(rows[0].hours, 1.5);
    assertEqual(rows[0].description, 'django-countries; invoicing setup');
});

test('mergeSessions: an empty note is skipped, duplicates collapse', () => {
    let rows = mergeSessions([
        session({ id: 'a', description: 'invoicing' }),
        session({ id: 'b', description: '' }),
        session({ id: 'c', description: 'invoicing' }),
    ], CLIENTS);
    assertEqual(rows[0].description, 'invoicing');
});

test('mergeSessions: billed hours win over actual', () => {
    let rows = mergeSessions([session({ billedHours: 0.75 })], CLIENTS);
    assertEqual(rows[0].hours, 0.75);
});

test('mergeSessions: the sum is rounded once, not per session', () => {
    // Three sessions of 10 minutes: 0.1666..h each. Rounding each would give
    // 0.17 * 3 = 0.51; rounding the sum gives 0.50.
    let rows = mergeSessions([
        session({ id: 'a', endMs: 600000 }),
        session({ id: 'b', endMs: 600000 }),
        session({ id: 'c', endMs: 600000 }),
    ], CLIENTS);
    assertEqual(rows[0].hours, 0.5);
});

test('mergeSessions: a single session landing exactly on a half-cent rounds up (1.005h -> 1.01)', () => {
    // 1h 0m 18s = 3,618,000ms = 1.005h exactly. In binary floating point,
    // 1.005 * 100 is actually ~100.49999999999999, so the old
    // Math.round(hours * 100) / 100 gave 1.00 here, not 1.01.
    let rows = mergeSessions([session({ endMs: 3618000 })], CLIENTS);
    assertEqual(rows[0].hours, 1.01);
});

test('mergeSessions: the same half-cent boundary reached via three summed billed hours rounds the same way', () => {
    // 0.335h * 3 = 1.005h, the same target as above, reached a different
    // way. Summing imprecise float hours directly used to round this
    // *upward* rather than downward like the single-session case above -
    // an inconsistency, not just an off-by-a-cent error. Millisecond
    // accumulation makes both land on the same 1.01.
    let rows = mergeSessions([
        session({ id: 'a', billedHours: 0.335 }),
        session({ id: 'b', billedHours: 0.335 }),
        session({ id: 'c', billedHours: 0.335 }),
    ], CLIENTS);
    assertEqual(rows[0].hours, 1.01);
});

test('mergeSessions: a sum landing on 2.675h rounds half-up to 2.68', () => {
    let rows = mergeSessions([session({ billedHours: 2.675 })], CLIENTS);
    assertEqual(rows[0].hours, 2.68);
});

test('mergeSessions: a sum landing on 0.125h rounds half-up to 0.13', () => {
    let rows = mergeSessions([session({ billedHours: 0.125 })], CLIENTS);
    assertEqual(rows[0].hours, 0.13);
});

test('mergeSessions: a billed override of 0.1h contributes exactly 0.10', () => {
    let rows = mergeSessions([session({ billedHours: 0.1 })], CLIENTS);
    assertEqual(rows[0].hours, 0.1);
});

test('mergeSessions: different days stay separate', () => {
    let rows = mergeSessions([
        session({ id: 'a', dayKey: '2026-09-11' }),
        session({ id: 'b', dayKey: '2026-09-12' }),
    ], CLIENTS);
    assertEqual(rows.map(r => r.date), ['2026-09-11', '2026-09-12']);
    assertEqual(rows.map(r => r.external_id), [
        'screen-time:ACME:2026-09-11', 'screen-time:ACME:2026-09-12',
    ]);
});

test('mergeSessions: non-billable clients are excluded', () => {
    let rows = mergeSessions([
        session({ id: 'a', client: 'ACME' }),
        session({ id: 'b', client: 'Self' }),
    ], CLIENTS);
    assertEqual(rows.map(r => r.client), ['ACME']);
});

test('mergeSessions: a client not on the list is excluded', () => {
    let rows = mergeSessions([session({ client: 'Ghost' })], CLIENTS);
    assertEqual(rows, []);
});

test('mergeSessions: a running session is excluded', () => {
    let rows = mergeSessions([session({ endMs: null })], CLIENTS);
    assertEqual(rows, []);
});

test('mergeSessions: a session with endMs before startMs is skipped (last line of defence)', () => {
    // clockStore's load-time validation and update() both already refuse a
    // record shaped like this, but mergeSessions must not rely on either -
    // these rows are money, so a negative computed duration is dropped
    // here too.
    let rows = mergeSessions([session({ startMs: 3600000, endMs: 0 })], CLIENTS);
    assertEqual(rows, []);
});

test('mergeSessions: re-export produces the same external_id', () => {
    let first = mergeSessions([session({ exportedAt: null })], CLIENTS);
    let again = mergeSessions([session({ exportedAt: 1757000000000 })], CLIENTS);
    assertEqual(first[0].external_id, again[0].external_id);
    assertEqual(again.length, 1, 'exportedAt never filters a row out');
});

test('mergeSessions: rows are ordered by date then client', () => {
    let rows = mergeSessions([
        session({ id: 'a', client: 'BETA', dayKey: '2026-09-12' }),
        session({ id: 'b', client: 'ACME', dayKey: '2026-09-12' }),
        session({ id: 'c', client: 'BETA', dayKey: '2026-09-11' }),
    ], CLIENTS);
    assertEqual(rows.map(r => [r.date, r.client]), [
        ['2026-09-11', 'BETA'], ['2026-09-12', 'ACME'], ['2026-09-12', 'BETA'],
    ]);
});

test('mergeSessions: ordering is code-point, not locale-aware (case-sensitive)', () => {
    // String.localeCompare collates via ICU and the running locale (and
    // typically case-insensitively), so 'a' can sort before 'B' on one
    // machine and after it on another. Rows upsert independently on
    // external_id, so their order carries no meaning, but it must still be
    // deterministic: plain code-point comparison always puts 'B' (0x42)
    // before 'a' (0x61).
    let clients = [
        { name: 'B', active: true, billable: true },
        { name: 'a', active: true, billable: true },
    ];
    let rows = mergeSessions([
        session({ id: 'x', client: 'a' }),
        session({ id: 'y', client: 'B' }),
    ], clients);
    assertEqual(rows.map(r => r.client), ['B', 'a']);
});

test('mergeSessions: a zeroed session still contributes 0 and yields a row', () => {
    let rows = mergeSessions([session({ billedHours: 0 })], CLIENTS);
    assertEqual(rows.length, 1, 'billedHours: 0 must not be treated as missing');
    assertEqual(rows[0].hours, 0);
});

test('mergeSessions: a day whose only session is zeroed exports hours: 0', () => {
    // Guards the upsert model: a day previously exported at 3.5h that gets
    // corrected to 0 must still be sent, or the invoicing side never learns
    // the total dropped and keeps the stale 3.5h forever.
    let rows = mergeSessions([
        session({ id: 'a', description: 'corrected to zero', billedHours: 0 }),
    ], CLIENTS);
    assertEqual(rows, [{
        external_id: 'screen-time:ACME:2026-09-11',
        client: 'ACME', date: '2026-09-11', hours: 0, description: 'corrected to zero',
    }]);
});

test('mergeSessions: a client name containing \':\' keeps external_id parseable', () => {
    // external_id is "{prefix}:{client}:{date}". The date is a fixed-width
    // (YYYY-MM-DD) final component, so even a client containing ':' can be
    // recovered by stripping the known prefix and date suffix.
    let rows = mergeSessions([session({ client: 'A:B' })], CLIENTS);
    assertEqual(rows.length, 1);
    assertEqual(rows[0].external_id, 'screen-time:A:B:2026-09-11');
    let withoutPrefix = rows[0].external_id.slice(`${EXTERNAL_ID_PREFIX}:`.length);
    let recoveredClient = withoutPrefix.slice(0, withoutPrefix.length - ':2026-09-11'.length);
    assertEqual(recoveredClient, 'A:B');
});

test('toJSON: serialises rows as an array with a trailing newline', () => {
    let json = toJSON([{
        external_id: 'screen-time:ACME:2026-09-11', client: 'ACME',
        date: '2026-09-11', hours: 1, description: '',
    }]);
    assertEqual(json.endsWith('\n'), true);
    assertEqual(JSON.parse(json), [{
        external_id: 'screen-time:ACME:2026-09-11', client: 'ACME',
        date: '2026-09-11', hours: 1, description: '',
    }]);
});

test('toCSV: header, and fields with commas or quotes are escaped', () => {
    let csv = toCSV([{
        external_id: 'screen-time:ACME:2026-09-11', client: 'ACME',
        date: '2026-09-11', hours: 1.25, description: 'fixed "the" bug, twice',
    }]);
    assertEqual(csv.split('\n')[0], 'external_id,client,date,hours,description');
    assertEqual(csv.split('\n')[1],
        'screen-time:ACME:2026-09-11,ACME,2026-09-11,1.25,"fixed ""the"" bug, twice"');
});

test('toCSV: a field with a comma, a double quote AND a newline is escaped as one field', () => {
    let rows = [{
        external_id: 'screen-time:ACME:2026-09-11', client: 'ACME',
        date: '2026-09-11', hours: 2,
        description: 'line one, "quoted"\nline two',
    }];
    let csv = toCSV(rows);
    let dataLines = csv.split('\n');
    // The embedded newline means the row's data spans two physical lines.
    assertEqual(dataLines.length, 4); // header, row line 1, row line 2, trailing ''
    assertEqual(dataLines[1] + '\n' + dataLines[2],
        'screen-time:ACME:2026-09-11,ACME,2026-09-11,2,"line one, ""quoted""\nline two"');
});

test('toCSV: a bare carriage return is escaped like a newline', () => {
    // /[",\n]/ alone misses a lone \r (no accompanying \n); many CSV
    // readers treat an unquoted \r as a row break just like \n.
    let rows = [{
        external_id: 'screen-time:ACME:2026-09-11', client: 'ACME',
        date: '2026-09-11', hours: 1, description: 'line one\rline two',
    }];
    let csv = toCSV(rows);
    assertEqual(csv.split('\n')[1],
        'screen-time:ACME:2026-09-11,ACME,2026-09-11,1,"line one\rline two"');
});

test('toCSV: a client name containing a comma is escaped', () => {
    let rows = [{
        // The comma lands in external_id too (it embeds the client name),
        // so both fields need quoting independently.
        external_id: 'screen-time:Acme, Inc:2026-09-11', client: 'Acme, Inc',
        date: '2026-09-11', hours: 1, description: '',
    }];
    let csv = toCSV(rows);
    assertEqual(csv.split('\n')[1],
        '"screen-time:Acme, Inc:2026-09-11","Acme, Inc",2026-09-11,1,');
});
