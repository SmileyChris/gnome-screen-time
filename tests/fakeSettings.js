import GLib from 'gi://GLib';

// Just enough of Gio.Settings for UsageStore: integer reads,
// `changed::<key>` signals that a test can fire by hand, the variant-typed
// keys clients.js reads and writes (`clients`, a(sbb), and `last-client`,
// s), and the booleans panelMode.js's migration reads and writes.
export class FakeSettings {
    constructor(ints = {}) {
        this._ints = {
            'retention-days': 90, 'max-interval': 300, 'day-start-hour': 0,
            'interval-retention-days': 30, 'clock-nudge-minutes': 30, ...ints,
        };
        this._values = { clients: new GLib.Variant('a(sbb)', []) };
        this._strings = { 'last-client': '', 'panel-time': 'screen' };
        this._booleans = { 'show-total-in-panel': true, 'panel-time-migrated': false };
        this._handlers = new Map();
        this._nextId = 1;
    }

    get_int(key) {
        return this._ints[key];
    }

    set_int(key, value) {
        this._ints[key] = value;
        this.emit(`changed::${key}`);
    }

    // Stored like the other typed keys (_ints, _strings): a plain object,
    // emitting the same `changed::<key>` signal on write.
    get_boolean(key) {
        return this._booleans[key];
    }

    set_boolean(key, value) {
        this._booleans[key] = value;
        this.emit(`changed::${key}`);
    }

    // GSettings variant-typed keys. clients.js reads and writes `clients`
    // (a(sbb)) and `last-client` (s) this way.
    get_value(key) {
        return this._values[key];
    }

    set_value(key, variant) {
        this._values[key] = variant;
        this.emit(`changed::${key}`);
    }

    get_string(key) {
        return this._strings[key] ?? '';
    }

    set_string(key, value) {
        this._strings[key] = value;
        this.emit(`changed::${key}`);
    }

    connect(signal, cb) {
        let id = this._nextId++;
        this._handlers.set(id, { signal, cb });
        return id;
    }

    disconnect(id) {
        this._handlers.delete(id);
    }

    emit(signal) {
        for (let h of this._handlers.values()) {
            if (h.signal === signal)
                h.cb(this);
        }
    }
}
