// Just enough of Gio.Settings for UsageStore: integer reads, and
// `changed::<key>` signals that a test can fire by hand.
export class FakeSettings {
    constructor(ints = {}) {
        this._ints = { 'retention-days': 90, 'max-interval': 300, ...ints };
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
