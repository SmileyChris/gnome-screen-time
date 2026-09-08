import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const STORE_DIR = GLib.build_filenamev([
    GLib.get_user_data_dir(), 'gnome-shell', 'screen-time'
]);
export const STORE_FILE = GLib.build_filenamev([STORE_DIR, 'usage.json']);
const AUTOSAVE_INTERVAL = 30;
const MANUAL_PURGE_DAYS = 7;

// Per-parent cap on named children per day, so unbounded detail keys (every
// repository, every URL path) cannot grow the single JSON file without limit.
// This is a storage bound; the popup's five-row display fold is separate.
export const MAX_CHILDREN = 20;
// Reserved child key that absorbs children folded out by MAX_CHILDREN.
export const OTHER_KEY = '__other__';

// Date keys double as the on-disk JSON keys, so this format is a storage
// contract, so every caller formats through here rather than repeating it.
export function dateKey(dateTime) {
    return dateTime.format('%Y-%m-%d');
}

export function todayKey() {
    return dateKey(GLib.DateTime.new_now_local());
}

// appId -> displayName for every app that appears anywhere in `data`. Shared
// by UsageStore (live in-memory data) and prefs.js (data read from disk) so
// both pick from the exact same set of "known" apps. Skips "Unknown",
// Shell's fallback name for windows it can't identify, not a real app.
export function knownAppsFromData(data) {
    let known = new Map();
    for (let day of Object.values(data)) {
        for (let [appId, info] of Object.entries(day)) {
            if (info.displayName !== 'Unknown')
                known.set(appId, info.displayName);
        }
    }
    return known;
}

// Children of a node as a list, biggest first. `count` is how many named
// siblings were folded into the OTHER_KEY entry (0 for ordinary children).
export function sortedChildren(children) {
    if (!children)
        return [];
    return Object.entries(children)
        .map(([id, node]) => ({
            id,
            displayName: node.displayName,
            seconds: node.seconds,
            count: node.count ?? 0,
            children: node.children ?? null,
        }))
        .sort((a, b) => b.seconds - a.seconds);
}

function namedCount(siblings) {
    return Object.keys(siblings).filter(k => k !== OTHER_KEY).length;
}

// Moves the smallest named sibling into OTHER_KEY. Its seconds stay under the
// same parent, so totals still reconcile at every level.
function foldSmallest(siblings) {
    let smallestId = null;
    for (let [id, node] of Object.entries(siblings)) {
        if (id === OTHER_KEY)
            continue;
        if (smallestId === null || node.seconds < siblings[smallestId].seconds)
            smallestId = id;
    }
    if (smallestId === null)
        return;
    let other = siblings[OTHER_KEY] ??= { displayName: 'Other', seconds: 0, count: 0 };
    other.seconds += siblings[smallestId].seconds;
    other.count += 1;
    delete siblings[smallestId];
}

// Adds `from` into `into`, recursing into children. Used once per load to
// fold the on-disk totals under time tracked while the read was in flight.
function mergeNode(into, from) {
    into.seconds += from.seconds;
    if (from.count)
        into.count = (into.count ?? 0) + from.count;
    if (!from.children)
        return;
    into.children ??= {};
    for (let [id, node] of Object.entries(from.children)) {
        if (into.children[id])
            mergeNode(into.children[id], node);
        else
            into.children[id] = node;
    }
    // A late-landing file can push a parent past the cap; fold back down so
    // the storage bound holds regardless of which side each child came from.
    while (namedCount(into.children) > MAX_CHILDREN)
        foldSmallest(into.children);
}

// Adds seconds to siblings[id], creating it if needed. `cap` is null for
// level 1 (apps were never capped) and MAX_CHILDREN below it.
function creditNode(siblings, id, displayName, seconds, cap) {
    let node = siblings[id];
    if (!node) {
        if (cap !== null && namedCount(siblings) >= cap)
            foldSmallest(siblings);
        node = siblings[id] = { displayName, seconds: 0 };
    }
    node.seconds += seconds;
    node.displayName = displayName;
    return node;
}

export class UsageStore {
    constructor(settings) {
        this._settings = settings;
        this._data = {};
        this._dirty = false;
        this._loaded = false;
        this._undo = null;
        this._cancellable = new Gio.Cancellable();
        this.onChange = null;
        this._ensureDir();
        this.loaded = this._load();
        this._autoSaveId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, AUTOSAVE_INTERVAL,
            () => { this._save(); return GLib.SOURCE_CONTINUE; }
        );
        this._settingsId = settings.connect(
            'changed::retention-days', () => { this._cleanup(); }
        );
        this._purgeId = settings.connect(
            'changed::purge-requested', () => { this._onPurgeRequested(); }
        );
    }

    _getRetentionDays() {
        return this._settings.get_int('retention-days');
    }

    _ensureDir() {
        let dir = Gio.File.new_for_path(STORE_DIR);
        if (!dir.query_exists(null))
            dir.make_directory_with_parents(null);
    }

    // Async so disk IO can't drop compositor frames (EGO-X-004). Time tracked
    // before the read lands is merged in, not discarded.
    async _load() {
        let loaded = null;
        try {
            let [contents] = await Gio.File.new_for_path(STORE_FILE)
                .load_contents_async(this._cancellable);
            loaded = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            // Cancelled by destroy(): the store is gone, nothing left to do.
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // A missing file is the normal first-run case, not an error.
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.error(`[ScreenTime] load error: ${e.message}`);
        }

        if (loaded)
            this._merge(loaded);
        this._loaded = true;
        this._cleanup();
        this.onChange?.();
    }

    _merge(loaded) {
        for (let [date, apps] of Object.entries(loaded)) {
            let day = this._data[date];
            if (!day) {
                this._data[date] = apps;
                continue;
            }
            // Keep anything tracked while the read was in flight, adding the
            // stored totals on top of it.
            for (let [appId, info] of Object.entries(apps)) {
                if (day[appId])
                    mergeNode(day[appId], info);
                else
                    day[appId] = info;
            }
        }
    }

    _save() {
        // Never write before the initial read resolves, or an empty object
        // would clobber the real history on disk.
        if (!this._dirty || !this._loaded) return;
        try {
            let json = JSON.stringify(this._data, null, 2);
            let file = Gio.File.new_for_path(STORE_FILE);
            file.replace_contents(
                new TextEncoder().encode(json),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
            this._dirty = false;
        } catch (e) {
            console.error(`[ScreenTime] save error: ${e.message}`);
        }
    }

    _cleanup() {
        let days = this._getRetentionDays();
        if (days <= 0) return;
        this._deleteOlderThan(days);
    }

    _onPurgeRequested() {
        if (this._deleteOlderThan(MANUAL_PURGE_DAYS)) {
            this._save();
            this.onChange?.();
        }
    }

    _deleteOlderThan(days) {
        let cutoffKey = dateKey(GLib.DateTime.new_now_local().add_days(-days));
        let changed = false;
        for (let key in this._data) {
            if (key < cutoffKey) {
                delete this._data[key];
                changed = true;
            }
        }
        if (changed)
            this._dirty = true;
        return changed;
    }

    // Credits `seconds` to every node on `path` ([appId], [appId, activityId]
    // or [appId, activityId, detailId]), so a level-1 total is always its own
    // direct time plus its children. `names` are the matching display names.
    addTime(path, names, seconds) {
        let today = todayKey();
        let day = this._data[today] ??= {};
        let secs = Math.round(seconds);
        let siblings = day;
        let top = null;
        for (let i = 0; i < path.length; i++) {
            let node = creditNode(siblings, path[i], names[i], secs,
                i === 0 ? null : MAX_CHILDREN);
            if (i === 0)
                top = node;
            if (i + 1 < path.length)
                siblings = node.children ??= {};
        }
        this._dirty = true;
        this.onChange?.(path[0], names[0], top.seconds);
    }

    // Sets a node's own time, the part not covered by its children, and
    // moves every ancestor by the same delta so totals keep reconciling.
    // For a leaf that is its whole value. `path` names the node as in
    // addTime; a node that ends at zero with no children is removed, and an
    // emptied children map is dropped. Returns whether anything changed.
    setDirectSeconds(dateKey, path, seconds) {
        let day = this._data[dateKey];
        if (!day || !Number.isFinite(seconds) || seconds < 0 || path.length === 0)
            return false;
        let target = Math.round(seconds);

        // Walk down, remembering each node so the delta can walk back up.
        let chain = [];
        let siblings = day;
        for (let id of path) {
            let node = siblings?.[id];
            if (!node)
                return false;
            chain.push({ siblings, id, node });
            siblings = node.children;
        }

        let leaf = chain[chain.length - 1].node;
        let childSum = Object.values(leaf.children ?? {}).reduce((s, c) => s + c.seconds, 0);
        let delta = target - (leaf.seconds - childSum);
        if (delta === 0)
            return false;

        this._snapshot(dateKey);
        for (let { node } of chain)
            node.seconds += delta;

        // Prune from the leaf upward: a node at zero with no children goes,
        // and a parent left with an empty map loses the map.
        for (let i = chain.length - 1; i >= 0; i--) {
            let { siblings: sibs, id, node } = chain[i];
            if (node.children && Object.keys(node.children).length === 0)
                delete node.children;
            if (node.seconds <= 0 && !node.children)
                delete sibs[id];
        }

        this._dirty = true;
        let top = day[path[0]];
        this.onChange?.(path[0], top?.displayName ?? null, top?.seconds ?? 0);
        return true;
    }

    // Removes a node and everything under it, taking its whole time off every
    // ancestor. Returns whether anything changed.
    removeNode(dateKey, path) {
        let day = this._data[dateKey];
        if (!day || path.length === 0)
            return false;
        let chain = [];
        let siblings = day;
        for (let id of path) {
            let node = siblings?.[id];
            if (!node)
                return false;
            chain.push({ siblings, id, node });
            siblings = node.children;
        }
        this._snapshot(dateKey);
        let { siblings: sibs, id, node: removed } = chain[chain.length - 1];
        delete sibs[id];
        for (let i = 0; i < chain.length - 1; i++) {
            let { node } = chain[i];
            node.seconds -= removed.seconds;
            if (node.children && Object.keys(node.children).length === 0)
                delete node.children;
        }
        // Ancestors emptied by the removal go too, leaf-most first.
        for (let i = chain.length - 2; i >= 0; i--) {
            let { siblings: s2, id: id2, node } = chain[i];
            if (node.seconds <= 0 && !node.children)
                delete s2[id2];
        }
        this._dirty = true;
        let top = day[path[0]];
        this.onChange?.(path[0], top?.displayName ?? null, top?.seconds ?? 0);
        return true;
    }

    // One level of undo for edits, in memory only: the day as it was before
    // the most recent setDirectSeconds or removeNode. A new edit replaces it.
    _snapshot(dateKey) {
        // Plain JSON data, and gjs has no structuredClone.
        this._undo = { dateKey, day: JSON.parse(JSON.stringify(this._data[dateKey])) };
    }

    canUndo(dateKey) {
        return this._undo?.dateKey === dateKey;
    }

    undo(dateKey) {
        if (!this.canUndo(dateKey))
            return false;
        this._data[dateKey] = this._undo.day;
        this._undo = null;
        this._dirty = true;
        this.onChange?.();
        return true;
    }

    getTodayTotal() {
        return this.getTotalForDate(todayKey());
    }

    // Per-app usage for one day, biggest first, unfiltered. Callers decide
    // what's worth showing.
    getUsageForDate(dateKey) {
        let day = this._data[dateKey];
        if (!day)
            return [];
        return Object.entries(day)
            .map(([appId, info]) => ({
                appId,
                displayName: info.displayName,
                seconds: info.seconds,
                children: info.children ?? null,
            }))
            .sort((a, b) => b.seconds - a.seconds);
    }

    getTotalForDate(dateKey) {
        let day = this._data[dateKey];
        if (!day)
            return 0;
        return Object.values(day).reduce((s, a) => s + a.seconds, 0);
    }

    // Oldest day still on record, so the UI knows how far back it can page.
    getOldestDate() {
        let keys = Object.keys(this._data);
        if (keys.length === 0)
            return null;
        return keys.reduce((a, b) => (a < b ? a : b));
    }

    getKnownApps() {
        return knownAppsFromData(this._data);
    }

    destroy() {
        this._cancellable.cancel();
        if (this._autoSaveId) {
            GLib.source_remove(this._autoSaveId);
            this._autoSaveId = null;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = null;
        }
        if (this._purgeId) {
            this._settings.disconnect(this._purgeId);
            this._purgeId = null;
        }
        this._save();
    }
}
