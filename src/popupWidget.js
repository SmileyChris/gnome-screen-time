import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { formatTime } from './formatTime.js';
import { todayKey, todayKeyFor, dateKey, OTHER_KEY, sortedChildren } from './usageStore.js';
import { AppTimerSection } from './appTimerSection.js';
import { ClockSection } from './clockSection.js';
import { isKnownClient, lastProject, pausedClient } from './clients.js';
import { ROW_W, DIM_OPACITY } from './usageBar.js';
import { makeRow, makeExpandableRow, addLongPress } from './usageRows.js';
import { getAppNames, setAppName } from './appNames.js';

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

// The clock card's colour says whether the clock is running: purple
// while one is (no usage tier is purple), neutral gray otherwise. Each
// lightens on hover, like the usage tiers.
const CLOCK_RUNNING = {from: '#dc8add', to: '#c061cb', hoverFrom: '#ebb6ea', hoverTo: '#dc8add'};
const CLOCK_STOPPED = {from: '#deddda', to: '#c0bfbc', hoverFrom: '#f6f5f4', hoverTo: '#deddda'};

// Both cards stack the same two lines, so their rows line up.
const TITLE_STYLE = 'font-size: 12px; font-weight: 600; color: ' + CARD_FG + ';';
const FIGURE_STYLE = 'font-size: 17px; font-weight: 800; color: ' + CARD_FG + ';';

function cardStyle(tier, hover) {
    let from = hover ? tier.hoverFrom : tier.from;
    let to = hover ? tier.hoverTo : tier.to;
    return 'padding: 10px 12px; border-radius: 14px; ' +
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

function labelForKey(key, startHour) {
    let today = todayKey(startHour);
    if (key === today)
        return 'Today';
    if (key === shiftKey(today, -1))
        return 'Yesterday';
    return keyToDate(key).format('%a, %b %-d');
}

export class PopupWidget {
    constructor(menu, store, settings, openPrefs, clock, onOpenTimesheet, intervalLog) {
        this._menu = menu;
        this._store = store;
        this._settings = settings;
        this._openPrefs = openPrefs;
        // Stored, not just passed through: the footer button and the split
        // card (later tasks) both read these back off `this`.
        this._clock = clock;
        this._onOpenTimesheet = onOpenTimesheet;
        // A getter: the log is created after the popup (see extension.js).
        this._intervalLog = intervalLog;
        this._date = todayKeyFor(settings);
        this._timerSection = new AppTimerSection(store, settings);
        // The client list's "Add client…" row opens the Timesheet on its
        // Clients page, where clients are managed.
        this._clockSection = new ClockSection(clock, settings, () => {
            this._menu.close();
            this._onOpenTimesheet?.({ clients: true });
        });
        // Paths (joined with \0) whose rows are expanded, so a rebuild after
        // an edit lands where the user was. Cleared on reopen and date change.
        this._expanded = new Set();
        this._expandables = [];
        // Whether the app rows show, once the Screen Time card was tapped;
        // null leaves it to _appsShown(). Cleared on reopen.
        this._showApps = null;
        // Whether the app rows show only the active client's sessions
        // rather than the whole day. Cleared on reopen.
        this._clientView = false;
        // Set while building the client view, whose rows are not editable:
        // edits write the day's totals, which that view is not.
        this._readOnly = false;

        this._build();

        this._openId = this._menu.connect('open-state-changed', (m, open) => {
            if (open) this._refresh();
        });
    }

    // The shortcut and the panel can change the clock without the popup being
    // open; this is how they ask it to redraw.
    refresh() {
        this._build();
    }

    _refresh() {
        this._date = todayKeyFor(this._settings);
        this._expanded.clear();
        this._showApps = null;
        this._clientView = false;
        this._timerSection.reset();
        this._clockSection.reset();
        this._build();
    }

    // The client whose clock is running or paused, on today only.
    _activeClient() {
        if (!this._clock || this._date !== todayKeyFor(this._settings))
            return null;
        let running = this._clock.running ?? null;
        return running?.client ?? pausedClient(this._settings, running);
    }

    // The app rows start hidden while a client clock runs or is paused, when
    // the clock card is what the popup is opened for.
    _appsShown() {
        return this._showApps ?? this._activeClient() === null;
    }

    // Screen time during `client`'s sessions today, from the interval log,
    // shaped like UsageStore.getUsageForDate() with renames applied.
    _clientUsage(client) {
        let log = this._intervalLog?.();
        if (!log)
            return { all: [], total: 0 };
        // Buffered intervals have not reached disk, and queries read files.
        log.flushAll();
        let now = Date.now();
        let ranges = this._clock.sessionsForDay(this._date)
            .filter(s => s.client === client)
            .map(s => [s.startMs, s.endMs ?? now]);
        let { seconds, entries } = log.queryRanges(ranges);
        let names = getAppNames(this._settings);
        for (let e of entries) {
            e.trackedName = e.displayName;
            e.displayName = names[e.appId] || e.displayName;
        }
        return { all: entries, total: seconds };
    }

    // How far back paging is allowed: every day in the retention window,
    // even empty ones (they render a "no data" panel instead of a dead arrow).
    _earliestKey() {
        let retention = this._settings.get_int('retention-days');
        if (retention > 0)
            return shiftKey(todayKeyFor(this._settings), -retention);
        return this._store.getOldestDate() ?? todayKeyFor(this._settings);
    }

    _build() {
        this._menu.removeAll();

        let all = this._store.getUsageForDate(this._date);
        // Same number the panel label shows, so the two can never disagree.
        let total = this._store.getTotalForDate(this._date);

        this._addDateNav();
        this._addTotalCard(total);
        this._addSeparator();

        // Hidden, the clock section follows the cards directly.
        if (this._appsShown()) {
            let client = this._activeClient();
            this._readOnly = false;
            if (client !== null) {
                let usage = this._clientUsage(client);
                this._addViewToggle(client, total, usage.total);
                if (this._clientView)
                    ({ all, total } = usage);
                this._readOnly = this._clientView;
            }
            if (all.length === 0) {
                let empty = new PopupMenu.PopupBaseMenuItem({activate: false});
                empty.track_hover = false;
                empty.style = 'padding: 0;';
                empty.add_child(new St.Label({
                    text: this._readOnly
                        ? `No screen time clocked to ${this._activeClient()} today`
                        : 'No data for this day',
                    opacity: DIM_OPACITY,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                    // Same outer width as a row (ROW_W plus 10px a side),
                    // so an empty view never widens the popup.
                    style: `font-size: 12px; padding: 14px 10px; width: ${ROW_W}px;`,
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
        }
        // The clock rows are a live control showing today's hours, so they sit
        // under today's breakdown only; paging back to an earlier day hides them
        // rather than mixing two days under one date heading.
        if (this._date === todayKeyFor(this._settings)) {
            this._clockSection.build(this._menu, () => this._build());
            this._addSeparator();
        }
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
        let canNext = this._date < todayKeyFor(this._settings);

        row.add_child(this._navButton('go-previous-symbolic', canPrev, () => {
            this._date = shiftKey(this._date, -1);
            this._expanded.clear();
            this._build();
        }));

        row.add_child(new St.Label({
            text: labelForKey(this._date, this._settings.get_int('day-start-hour')),
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

    // Above the app rows while a client clock runs or is paused: whether
    // they cover the whole day or only that client's sessions (all of
    // today's, not just the current one).
    _addViewToggle(client, dayTotal, clientTotal) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let row = new St.BoxLayout({
            x_expand: true,
            style: 'padding: 2px 10px 4px 10px; spacing: 6px;',
        });
        let option = (text, clientView) => {
            // Own label rather than `label:`, whose child is no St.Label, so
            // a long client name can be ellipsized.
            let label = new St.Label({text});
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            let btn = new St.Button({
                child: label,
                style_class: 'button',
                style: 'font-size: 10px; padding: 2px 10px;',
                can_focus: true,
                checked: this._clientView === clientView,
                x_expand: true,
            });
            btn.connect('clicked', () => {
                this._clientView = clientView;
                this._build();
            });
            return btn;
        };
        row.add_child(option(`${formatTime(dayTotal)} total`, false));
        row.add_child(option(`${formatTime(clientTotal)} ${client}`, true));
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

        // Two cards side by side, kept the same width whatever each holds.
        let cards = new St.Widget({
            x_expand: true,
            layout_manager: new Clutter.BoxLayout({homogeneous: true, spacing: 8}),
            style: 'margin: 4px 10px 2px 10px;',
        });

        // Left card: screen time. A tap shows or hides the app rows; a long
        // press flips what the bars and percentages compare against.
        let tier = tierFor(total);
        let screen = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            reactive: true,
            track_hover: true,
            style_class: 'screen-time-card',
            style: cardStyle(tier, false),
        });
        screen.add_child(new St.Label({text: 'Screen Time', style: TITLE_STYLE}));
        screen.add_child(new St.Label({
            text: total > 0 ? formatTime(total) : '0m',
            style: FIGURE_STYLE,
        }));
        // The gradient is per-usage and therefore inline, which outranks any
        // stylesheet :hover rule, so the hover swap is done here instead.
        screen.connect('notify::hover', () => {
            screen.style = cardStyle(tier, screen.hover);
        });
        let press = addLongPress(screen, () => {
            this._settings.set_string('percent-basis',
                this._percentBasis() === 'largest' ? 'total' : 'largest');
            this._build();
        });
        screen.connect('button-release-event', () => {
            if (press.pressed) {
                press.pressed = false;   // the release that ended a long press
                return Clutter.EVENT_STOP;
            }
            this._showApps = !this._appsShown();
            this._build();
            return Clutter.EVENT_STOP;
        });
        cards.add_child(screen);

        // Right card: the clock, reflecting the day on screen rather than
        // always today. The clock rows section hides itself on any day but
        // today for the same reason (a live control mixed with another
        // day's numbers is misleading) - see _build()'s call to
        // _clockSection.build().
        //
        // Running: the client and its own time today, with a pause button.
        // Paused (no session, but last-client names a client to resume):
        // the same, with stop and play buttons. Stopped, or any earlier day:
        // the day's clocked total, no buttons. Stop forgets last-client, so
        // nothing can resume it and the panel stops showing a total (see
        // panelMode.js). Tapping the card itself pauses or resumes, like
        // the pause and play buttons; on a total above zero, it opens the
        // Timesheet at that day.
        let isToday = this._date === todayKeyFor(this._settings);
        let running = isToday ? (this._clock?.running ?? null) : null;
        // See clients.js's pausedClient for exactly when that is.
        let resumable = isToday && this._clock ? pausedClient(this._settings, running) : null;
        let paused = resumable !== null;
        let client = running?.client ?? resumable;
        // The running session's project, or the one a resume would restart.
        let project = running ? running.project
            : resumable !== null ? lastProject(this._settings, resumable) : null;
        let canToggle = client !== null;
        // Which session the note button (below) opens: the one actually
        // running, or - while paused - the client's latest session today
        // (sessionsForDay() sorts by startMs, so the last one is the
        // latest), since a note written now belongs to that one. Null
        // whenever there's nothing to toggle, which is also when no button
        // shows at all: the clock's stopped, or this is an earlier day.
        let noteSession = running
            ?? (paused ? this._clock.sessionsForDay(this._date)
                .filter(s => s.client === client).at(-1) ?? null : null);
        let noteSessionId = noteSession?.id ?? null;
        // Same rules as the clock rows below and the day total, so the card
        // can never disagree with either.
        let figure = !this._clock ? 0
            : client !== null ? this._clock.billedSecondsByClient(this._date).get(client) ?? 0
            : this._clock.billedSecondsForDay(this._date);
        // Nothing to pause or resume, so the card is just the day's total:
        // tapping it opens the Timesheet at that day, where the total is
        // broken down. A zero total has nothing to show, so it stays inert.
        let opensTimesheet = !canToggle && figure > 0;
        let tappable = canToggle || opensTimesheet;
        let clockTier = running ? CLOCK_RUNNING : CLOCK_STOPPED;
        let clock = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            reactive: tappable,
            track_hover: tappable,
            style_class: 'screen-time-card',
            style: cardStyle(clockTier, false),
        });

        // Client names are free-form and unbounded, unlike every other
        // label on these cards - a long one must not widen this card, and
        // with it (the cards share one width) the popup, past ROW_W. Capped
        // to what half of ROW_W leaves after the cards' padding and gap;
        // the full name stays visible in the clock rows below
        // (ClockSection), which ellipsize the same way. The buttons share
        // that width, so each takes its own share off the cap.
        let titleRow = new St.BoxLayout({style: 'spacing: 2px;'});
        let title = new St.Label({
            text: client !== null ? (project ? `${client} · ${project}` : client)
                : (isToday ? 'Clocked today' : 'Clocked'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleRow.add_child(title);

        // Pause and play both re-derive the state at tap time rather than
        // closing over `running`: the panel/shortcut can change the clock
        // while the popup is still open (see ClockSection.build()).
        // Resuming from the card (a tap on it, or its play button) is done
        // with the popup, so it closes. Pausing leaves it open to show the
        // paused state, and so does a failed resume.
        let toggle = () => {
            let resumed = false;
            try {
                let last = this._settings.get_string('last-client');
                if (this._clock.running) {
                    this._clock.stop();
                } else if (isKnownClient(this._settings, last)) {
                    this._clock.start(last, Date.now(), { project: lastProject(this._settings, last) });
                    resumed = true;
                }
            } catch (e) {
                // start()/stop() throw when the system clock is out of
                // range; the popup has no toast, so log and let the
                // rebuild show whatever state actually landed.
                console.error(`[ScreenTime] clock toggle failed: ${e.message}`);
            } finally {
                this._build();
                if (resumed)
                    this._menu.close();
            }
        };
        let stop = () => {
            try {
                if (this._clock.running)
                    this._clock.stop();
                // Only once stop() has not thrown: a failed stop leaves the
                // session running, and it stays resumable.
                this._settings.set_string('last-client', '');
                this._settings.set_string('last-project', '');
            } catch (e) {
                console.error(`[ScreenTime] clock stop failed: ${e.message}`);
            } finally {
                this._build();
            }
        };
        // `text`, when given, is shown before the icon.
        let cardButton = (iconName, name, onClick, text = null) => {
            let icon = new St.Icon({
                icon_name: iconName,
                icon_size: 12,
                style: `color: ${CARD_FG};`,
            });
            let child = icon;
            if (text) {
                child = new St.BoxLayout({ style: 'spacing: 4px; padding-left: 4px;' });
                child.add_child(new St.Label({
                    text,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `font-size: 10px; color: ${CARD_FG};`,
                }));
                child.add_child(icon);
            }
            let btn = new St.Button({
                child,
                can_focus: true,
                accessible_name: name,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'screen-time-card-button',
            });
            btn.connect('clicked', onClick);
            return btn;
        };
        let buttons = running
            ? [cardButton('media-playback-pause-symbolic', 'Pause', toggle)]
            : paused
                ? [cardButton('media-playback-stop-symbolic', 'Stop', stop),
                    cardButton('media-playback-start-symbolic', 'Play', toggle)]
                : [];
        for (let btn of buttons)
            titleRow.add_child(btn);
        title.style = TITLE_STYLE +
            ` max-width: ${Math.round(ROW_W / 2) - 36 - 20 * buttons.length}px;`;
        clock.add_child(titleRow);

        // The figure is the client's time today, while the panel shows the
        // running session's own time. Once the client has two or more
        // sessions today the two differ, so a small count after the figure
        // says why. Capped like the title, so it can never widen the card:
        // the count ellipsizes before the figure gives up any room.
        // A small note button at the card's bottom-right, on the figure's
        // line so the card keeps its size. It closes the popup and opens
        // the Timesheet with this session already expanded and its Note
        // field focused, so a thought that occurs to you here doesn't have
        // to survive an extra "which session was that" once the Timesheet's
        // open.
        let noteButton = noteSessionId !== null
            ? cardButton('document-edit-symbolic', 'Note', () => {
                this._menu.close();
                this._onOpenTimesheet?.({ note: noteSessionId });
            // Says whether there is a note yet, so an empty one invites a
            // first note rather than looking like the button to read one.
            }, noteSession.description.trim() ? 'Edit' : 'Add')
            : null;

        let figureRow = new St.BoxLayout({
            style: `spacing: 5px; max-width: ${Math.round(ROW_W / 2) - 36}px;`,
        });
        figureRow.add_child(new St.Label({
            text: figure > 0 ? formatTime(figure) : '0m',
            style: FIGURE_STYLE,
        }));
        let sessionCount = client !== null && this._clock
            ? this._clock.sessionsForDay(this._date).filter(s => s.client === client).length
            : 0;
        if (sessionCount >= 2) {
            let count = new St.Label({
                text: `${sessionCount} sessions`,
                opacity: DIM_OPACITY,
                y_align: Clutter.ActorAlign.END,
                style: `font-size: 10px; padding-bottom: 3px; color: ${CARD_FG};`,
            });
            count.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            figureRow.add_child(count);
        }
        if (noteButton) {
            figureRow.add_child(new St.Widget({ x_expand: true }));
            noteButton.y_align = Clutter.ActorAlign.END;
            figureRow.add_child(noteButton);
        }
        clock.add_child(figureRow);

        if (tappable) {
            // Same inline-gradient hover swap as the screen time card.
            clock.connect('notify::hover', () => {
                clock.style = cardStyle(clockTier, clock.hover);
            });
            clock.connect('button-release-event', () => {
                if (opensTimesheet) {
                    this._menu.close();
                    this._onOpenTimesheet?.({ day: this._date });
                } else if (!buttons.some(btn => btn.hover) && !noteButton?.hover) {
                    // A release over a button (pause/play/stop, or the note
                    // button in its own row below) is that button's click,
                    // not a tap on the card around it.
                    toggle();
                }
                return Clutter.EVENT_STOP;
            });
        }

        cards.add_child(clock);

        item.add_child(cards);
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
        // Below level 1 the parent's own time shows as an "Unattributed" row.
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
        // only. Surface the gap as an "Unattributed" leaf so the visible
        // rows still sum to the parent's total. At zero it stays hidden until
        // a long press on the parent reveals it, so direct time can be added.
        if (depth > 0) {
            let row = this._addLeaf({
                name: 'Unattributed',
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
            editable: this._readOnly ? null : {
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
        // Only level-1 apps are renamed: their ids are unique on their own,
        // where a child's is only unique under its parent.
        if (depth === 0 && !this._readOnly) {
            opts.rename = {
                renamed: entry.displayName !== entry.trackedName,
                trackedName: entry.trackedName,
                onRename: name => {
                    setAppName(this._settings, entry.appId, name);
                    this._build();
                },
            };
        }
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
            onLongPress: this._readOnly ? null : () => {
                row.expand();
                kids?.noBreakdown?.reveal();
            },
            onDelete: this._readOnly ? null : () => {
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
        let timesheetBox = new St.BoxLayout();
        timesheetBox.add_child(new St.Icon({
            icon_name: 'x-office-spreadsheet-symbolic',
            icon_size: 14,
        }));
        timesheetBox.add_child(new St.Label({
            text: 'Timesheet',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; padding-left: 4px;',
        }));
        let timesheetButton = new St.Button({
            child: timesheetBox,
            style_class: 'screen-time-nav-button',
            can_focus: true,
            style: 'margin-left: 8px;',
        });
        timesheetButton.connect('clicked', () => {
            this._menu.close();
            this._onOpenTimesheet?.();
        });
        row.add_child(timesheetButton);

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
        this._clockSection?.destroy();
        this._clockSection = null;
        this._menu = null;
        this._store = null;
        this._settings = null;
        this._openPrefs = null;
        this._clock = null;
        this._onOpenTimesheet = null;
        this._timerSection = null;
    }
}
