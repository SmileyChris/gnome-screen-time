import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { formatTime } from './formatTime.js';
import { todayKey, dateKey, OTHER_KEY, sortedChildren } from './usageStore.js';
import { AppTimerSection } from './appTimerSection.js';
import { ROW_W, DIM_OPACITY } from './usageBar.js';
import { makeRow, makeExpandableRow } from './usageRows.js';

const MAX_VISIBLE = 5;
const MIN_ROW_SECONDS = 60;
const COLORS = ['#3584e4', '#33d17a', '#e5a50a', '#9141ac', '#ed333b'];

// Noun for the "Other N ..." fold row at each depth.
const NOUNS = ['apps', 'activities', 'details'];

function pctOf(part, whole) {
    return whole > 0 ? Math.round(part / whole * 100) : 0;
}

// The card paints its own background, so it needs its own dark-mode foreground too.
const CARD_FG = '#241f31';

// Adwaita palette; each tier lightens one shade on hover.
const USAGE_TIERS = [
    {limit: 2 * 3600, from: '#8ff0a4', to: '#57e389', hoverFrom: '#b3f7c4', hoverTo: '#8ff0a4'},
    {limit: 5 * 3600, from: '#99c1f1', to: '#62a0ea', hoverFrom: '#bfd8f7', hoverTo: '#99c1f1'},
    {limit: Infinity, from: '#ffbdb6', to: '#f66151', hoverFrom: '#ffd6d1', hoverTo: '#ffbdb6'},
];

function tierFor(seconds) {
    return USAGE_TIERS.find(t => seconds < t.limit) ?? USAGE_TIERS.at(-1);
}

function cardStyle(tier, hover) {
    let from = hover ? tier.hoverFrom : tier.from;
    let to = hover ? tier.hoverTo : tier.to;
    return 'margin: 4px 10px 2px 10px; padding: 10px 14px; border-radius: 14px; ' +
           'background-gradient-direction: vertical; ' +
           'background-gradient-start: ' + from + '; ' +
           'background-gradient-end: ' + to + ';';
}

function keyToDate(key) {
    let [y, m, d] = key.split('-').map(Number);
    return GLib.DateTime.new_local(y, m, d, 0, 0, 0);
}

function shiftKey(key, days) {
    return dateKey(keyToDate(key).add_days(days));
}

function labelForKey(key) {
    let today = todayKey();
    if (key === today)
        return 'Today';
    if (key === shiftKey(today, -1))
        return 'Yesterday';
    return keyToDate(key).format('%a, %b %-d');
}

export class PopupWidget {
    constructor(menu, store, settings, openPrefs) {
        this._menu = menu;
        this._store = store;
        this._settings = settings;
        this._openPrefs = openPrefs;
        this._date = todayKey();
        this._timerSection = new AppTimerSection(store, settings);
        // Paths (joined with \0) whose rows are expanded, so a rebuild after
        // an edit lands where the user was. Cleared on reopen and date change.
        this._expanded = new Set();
        this._expandables = [];

        this._build();

        this._openId = this._menu.connect('open-state-changed', (m, open) => {
            if (open) this._refresh();
        });
    }

    _refresh() {
        this._date = todayKey();
        this._expanded.clear();
        this._timerSection.reset();
        this._build();
    }

    // How far back paging is allowed: every day in the retention window,
    // even empty ones (they render a "no data" panel instead of a dead arrow).
    _earliestKey() {
        let retention = this._settings.get_int('retention-days');
        if (retention > 0)
            return shiftKey(todayKey(), -retention);
        return this._store.getOldestDate() ?? todayKey();
    }

    _build() {
        this._menu.removeAll();

        let all = this._store.getUsageForDate(this._date);
        // Same number the panel label shows, so the two can never disagree.
        let total = this._store.getTotalForDate(this._date);

        this._addDateNav();
        this._addTotalCard(total);
        this._addSeparator();

        if (all.length === 0) {
            let empty = new PopupMenu.PopupBaseMenuItem({activate: false});
            empty.track_hover = false;
            empty.style = 'padding: 0;';
            empty.add_child(new St.Label({
                text: 'No data for this day',
                opacity: DIM_OPACITY,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 12px; padding: 14px; width: ${ROW_W}px;`,
            }));
            this._menu.addMenuItem(empty);
        } else {
            this._expandables = [];
            this._addEntries(all, total, 0, []);
            for (let { key, row } of this._expandables) {
                if (this._expanded.has(key))
                    row.expand();
            }
        }

        this._addSeparator();
        this._timerSection.build(this._menu, () => this._build());
        if (this._timerSection.isOpen)
            this._addSeparator();
        this._addFooter();
    }

    _percentBasis() {
        return this._settings.get_string('percent-basis');
    }

    // What a level's rows are measured against: the parent's total, or the
    // biggest named row at that level so the top item reads 100%.
    _basisFor(named, parentTotal) {
        if (this._percentBasis() !== 'largest')
            return parentTotal;
        return named.reduce((m, e) => Math.max(m, e.seconds), 0) || parentTotal;
    }

    _addSeparator() {
        let sep = new PopupMenu.PopupSeparatorMenuItem();
        sep.style = 'margin: 2px 10px;';
        this._menu.addMenuItem(sep);
    }

    _addDateNav() {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';

        let row = new St.BoxLayout({
            x_expand: true,
            style: 'padding: 10px 10px; min-height: 20px;',
        });

        let canPrev = this._date > this._earliestKey();
        let canNext = this._date < todayKey();

        row.add_child(this._navButton('go-previous-symbolic', canPrev, () => {
            this._date = shiftKey(this._date, -1);
            this._expanded.clear();
            this._build();
        }));

        row.add_child(new St.Label({
            text: labelForKey(this._date),
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 12px; font-weight: 700;',
        }));

        row.add_child(this._navButton('go-next-symbolic', canNext, () => {
            this._date = shiftKey(this._date, 1);
            this._expanded.clear();
            this._build();
        }));

        item.add_child(row);
        this._menu.addMenuItem(item);
    }

    _navButton(iconName, enabled, onClick) {
        let btn = new St.Button({
            child: new St.Icon({icon_name: iconName, icon_size: 14}),
            style_class: 'screen-time-nav-button',
            reactive: enabled,
            can_focus: enabled,
            opacity: enabled ? 255 : 55,
        });
        if (enabled)
            btn.connect('clicked', onClick);
        return btn;
    }

    _addTotalCard(total) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';

        let tier = tierFor(total);
        let card = new St.BoxLayout({
            x_expand: true,
            reactive: true,
            track_hover: true,
            style_class: 'screen-time-card',
            style: cardStyle(tier, false),
        });

        let titles = new St.BoxLayout({ vertical: true, y_align: Clutter.ActorAlign.CENTER });
        titles.add_child(new St.Label({
            text: 'Total Screen Time',
            style: 'font-size: 12px; font-weight: 600; color: ' + CARD_FG + ';',
        }));
        titles.add_child(new St.Label({
            text: this._percentBasis() === 'largest' ? 'bars: of largest' : 'bars: of total',
            opacity: DIM_OPACITY,
            style: 'font-size: 9px; color: ' + CARD_FG + ';',
        }));
        card.add_child(titles);
        card.add_child(new St.BoxLayout({x_expand: true}));
        card.add_child(new St.Label({
            text: total > 0 ? formatTime(total) : '0m',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 17px; font-weight: 800; color: ' + CARD_FG + ';',
        }));

        // The gradient is per-usage and therefore inline, which outranks any
        // stylesheet :hover rule, so the hover swap is done here instead.
        card.connect('notify::hover', () => {
            card.style = cardStyle(tier, card.hover);
        });
        // Clicking the card flips what the row percentages compare against.
        card.connect('button-release-event', () => {
            this._settings.set_string('percent-basis',
                this._percentBasis() === 'largest' ? 'total' : 'largest');
            this._build();
            return Clutter.EVENT_STOP;
        });

        item.add_child(card);
        this._menu.addMenuItem(item);
    }

    // Renders one level of entries as rows under `parentTotal`, returning the
    // rows so an expandable parent can show and hide them. Entries carry
    // `displayName`, `seconds` and optional `children`; below level 1 they
    // also carry `id`, which the store's fold key is matched on.
    _addEntries(entries, parentTotal, depth, parentPath) {
        let stored = entries.find(e => e.id === OTHER_KEY);
        let named = entries.filter(e => e !== stored);

        // The one-minute floor applies at level 1 only. Deeper, a day of
        // short sessions would otherwise show an almost empty breakdown.
        let eligible = depth === 0
            ? named.filter(e => e.seconds >= MIN_ROW_SECONDS)
            : named;
        let top = eligible.slice(0, MAX_VISIBLE);

        // Everything not given its own row, including anything the store
        // already folded, goes here so the rows reconcile with the parent.
        let rest = named.filter(e => !top.includes(e));
        let restSeconds = rest.reduce((s, e) => s + e.seconds, 0) + (stored?.seconds ?? 0);
        let restCount = rest.length + (stored?.count ?? 0);
        // Below level 1 the parent's own time shows as a "No breakdown" row.
        let direct = depth > 0
            ? Math.max(0, parentTotal - entries.reduce((s, e) => s + e.seconds, 0))
            : 0;

        // "Largest" scaling measures against the biggest row actually shown
        // at this level, which may be the fold or the direct-time row.
        let basis = this._basisFor([...named, { seconds: restSeconds }, { seconds: direct }], parentTotal);
        let rows = top.map((e, i) =>
            this._addEntry(e, parentTotal, depth, COLORS[i % COLORS.length], parentPath, basis));
        if (restCount > 0) {
            let row = makeExpandableRow({
                name: `Other ${restCount} ${NOUNS[depth]}`,
                seconds: restSeconds,
                pct: pctOf(restSeconds, parentTotal),
                barPct: pctOf(restSeconds, basis),
                color: COLORS[top.length % COLORS.length],
                depth,
                dim: true,
            });
            this._menu.addMenuItem(row.item);
            row.setChildren(rest.map((e, i) => this._addEntry(e, parentTotal, depth,
                COLORS[(MAX_VISIBLE + i) % COLORS.length], parentPath, basis)));
            rows.push(row);
        }

        // Below level 1, a node's own seconds is its direct time plus its
        // children (see UsageStore.addTime), but direct time has no entry
        // of its own: a terminal pane with no zellij session, or the
        // interval before the source resolves, is credited to the parent
        // only. Surface the gap as an unlabeled leaf so the visible rows
        // still sum to the parent's total. At zero it stays hidden until a
        // long press on the parent reveals it, so direct time can be added.
        if (depth > 0) {
            let row = this._addLeaf({
                name: 'No breakdown',
                seconds: direct,
                pct: pctOf(direct, parentTotal),
                barPct: pctOf(direct, basis),
                color: COLORS[(top.length + 1) % COLORS.length],
                depth,
                dim: true,
                suppressed: direct === 0,
            }, parentPath, parentTotal);
            rows.push(row);
            rows.noBreakdown = row;
        }
        return rows;
    }

    // A leaf row that can be long-pressed into edit mode. Saving writes the
    // node's direct time (its whole value for a leaf) and rebuilds the
    // popup with the same rows expanded.
    _addLeaf(opts, path, parentTotal) {
        let row = makeRow({
            ...opts,
            editable: {
                parentTotal,
                onSave: seconds => {
                    this._store.setDirectSeconds(this._date, path, seconds);
                    this._build();
                },
            },
        });
        this._menu.addMenuItem(row.item);
        for (let extra of row.extraItems)
            this._menu.addMenuItem(extra);
        return row;
    }

    // One entry as a row. Entries with children become expandable and their
    // children are rendered as a nested level, bars relative to this entry.
    _addEntry(entry, parentTotal, depth, color, parentPath, basis = parentTotal) {
        let path = [...parentPath, entry.appId ?? entry.id];
        let children = sortedChildren(entry.children);
        let opts = {
            name: entry.displayName,
            seconds: entry.seconds,
            pct: pctOf(entry.seconds, parentTotal),
            barPct: pctOf(entry.seconds, basis),
            color,
            depth,
        };
        if (children.length === 0)
            return this._addLeaf(opts, path, parentTotal);

        let key = path.join('\0');
        let kids = null;
        let row = makeExpandableRow({
            ...opts,
            onToggle: expanded => {
                if (expanded)
                    this._expanded.add(key);
                else
                    this._expanded.delete(key);
            },
            // Holding a parent opens it and shows its direct-time row even
            // at zero, since parents themselves are not edited.
            onLongPress: () => {
                row.expand();
                kids?.noBreakdown?.reveal();
            },
            onDelete: () => {
                this._store.removeNode(this._date, path);
                this._build();
            },
        });
        this._menu.addMenuItem(row.item);
        for (let extra of row.extraItems)
            this._menu.addMenuItem(extra);
        kids = this._addEntries(children, entry.seconds, depth + 1, path);
        row.setChildren(kids);
        this._expandables.push({ key, row });
        return row;
    }

    _addFooter() {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';

        let row = new St.BoxLayout({x_expand: true, style: 'padding: 0 8px 2px 8px;'});
        row.add_child(this._timerSection.createToggleButton(() => this._build()));
        // One level of undo for the last edit on the day being shown; the
        // store forgets it on the next edit or when the extension restarts.
        if (this._store.canUndo(this._date)) {
            let undo = new St.Button({
                label: 'Undo edit',
                style_class: 'button',
                style: 'font-size: 10px; padding: 2px 10px; margin-left: 8px;',
                can_focus: true,
            });
            undo.connect('clicked', () => {
                this._store.undo(this._date);
                this._build();
            });
            row.add_child(undo);
        }
        row.add_child(new St.BoxLayout({x_expand: true}));   // pushes the settings button right

        let btn = new St.Button({
            child: new St.Icon({icon_name: 'preferences-system-symbolic', icon_size: 14}),
            style_class: 'screen-time-settings-button',
            opacity: DIM_OPACITY,
            can_focus: true,
        });
        btn.connect('clicked', () => {
            this._menu.close();
            this._openPrefs?.();
        });
        row.add_child(btn);

        item.add_child(row);
        this._menu.addMenuItem(item);
    }

    destroy() {
        // The menu itself is owned by PanelIndicator, but drop the handler
        // explicitly so a late emission can't reach an already-destroyed store.
        if (this._openId) {
            this._menu.disconnect(this._openId);
            this._openId = null;
        }
        this._menu = null;
        this._store = null;
        this._settings = null;
        this._openPrefs = null;
        this._timerSection = null;
    }
}
