import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { formatTime } from './formatTime.js';
import { ROW_W, DIM_OPACITY } from './usageBar.js';
import { INDENT } from './usageRows.js';
import { recentClients, pausedClient, activeProjects, lastProject } from './clients.js';
import { todayKeyFor } from './usageStore.js';

const ARROW_CLOSED = ' ▸';
const ARROW_OPEN = ' ▾';

// Rows below the app breakdown: one per client, tap to clock in, tap the
// running one to pause it (the clock card's stop button is the only way to
// stop outright). The list doubles as the readout and the control, so there
// is no separate start button. A play/pause icon at the right edge, before
// the time, shows what tapping that row does. A client with projects
// expands instead of clocking in directly: its own row toggles the list of
// General and each active project, which are the rows that actually clock
// in. A last "Add client…" row opens the Timesheet, where clients are
// managed.
//
// Rebuilt from scratch inside PopupWidget._build(), exactly like
// AppTimerSection: _build() starts with menu.removeAll(), which destroys
// every item, so this section holds no item references between builds.
export class ClockSection {
    constructor(clock, settings, onAddClient) {
        this._clock = clock;
        this._settings = settings;
        this._onAddClient = onAddClient;
        this._expanded = null;
    }

    // Forgets which clients were expanded, so the next build starts from
    // last-client again. Called when the popup reopens.
    reset() {
        this._expanded = null;
    }

    // Appends one row per client to `menu`, then the "Add client…" row.
    //
    // Each row is a non-activating PopupBaseMenuItem holding an St.Button:
    // a plain activating item's default 'activate' handler unconditionally
    // closes the top menu (PopupMenuBase._connectItemSignals() -> AFTER
    // handler -> itemActivated()), which would discard the very rebuild the
    // tap just triggered and give the user no in-popup confirmation that
    // they clocked in. Every other clickable row in this popup
    // (usageRows.js, appTimerSection.js) uses the same button-in-item shape
    // for the same reason.
    build(menu, rebuild) {
        let dayKey = todayKeyFor(this._settings);
        let names = recentClients(this._settings, this._clock, dayKey);

        // Same rule the day total uses, so a row and the total can never
        // disagree.
        let byClient = this._clock.billedSecondsByClient(dayKey);
        let running = this._clock.running ?? null;
        // Same rule as the clock card, so the two never disagree about which
        // client is paused.
        let paused = pausedClient(this._settings, running);

        // Clients with projects expand to list General and each active
        // project; the last-used client starts expanded, since that is the
        // one most likely to be switched between projects.
        if (this._expanded === null) {
            let last = this._settings.get_string('last-client');
            this._expanded = new Set(last ? [last] : []);
        }
        let pausedProject = paused !== null ? lastProject(this._settings, paused) : null;

        for (let name of names) {
            let projects = activeProjects(this._settings, name);
            let runningHere = running?.client === name;
            let pausedHere = name === paused;
            let secs = byClient.get(name) ?? 0;

            // A project that was deactivated or deleted after being clocked
            // into must still get a row: otherwise, once it's the client's
            // last such project, the client renders as a plain row and
            // tapping it calls _tap(name, null), switching to General
            // instead of pausing or resuming the project actually running
            // or paused.
            if (runningHere && running.project !== null && !projects.includes(running.project))
                projects.push(running.project);
            if (pausedHere && pausedProject !== null && !projects.includes(pausedProject))
                projects.push(pausedProject);

            if (projects.length === 0) {
                this._addRow(menu, {
                    text: name, bold: runningHere, depth: 0, secs,
                    state: runningHere ? 'running' : pausedHere ? 'paused' : null,
                    onTap: () => this._tap(name, null, rebuild),
                });
                continue;
            }

            let expanded = this._expanded.has(name);
            this._addRow(menu, {
                text: name, bold: runningHere, depth: 0, secs,
                arrow: expanded ? ARROW_OPEN : ARROW_CLOSED,
                // Collapsed, the client row shows its project's state so a
                // running clock is never hidden.
                state: expanded ? null : runningHere ? 'running' : pausedHere ? 'paused' : null,
                onTap: () => {
                    if (expanded)
                        this._expanded.delete(name);
                    else
                        this._expanded.add(name);
                    rebuild();
                },
            });
            if (!expanded)
                continue;

            let byProject = this._clock.billedSecondsByProject(dayKey, name);
            for (let project of [null, ...projects]) {
                let isRunning = runningHere && running.project === project;
                let isPaused = pausedHere && pausedProject === project;
                this._addRow(menu, {
                    text: project ?? 'General', bold: isRunning, depth: 1,
                    secs: byProject.get(project) ?? 0,
                    state: isRunning ? 'running' : isPaused ? 'paused' : null,
                    onTap: () => this._tap(name, project, rebuild),
                });
            }
        }

        // Always the last row, even with no clients at all, so a fresh
        // install shows where clients come from. Clients are only created in
        // the Timesheet's Clients page (see clientsPage.js), because the
        // popup cannot take text input sanely.
        let addRow = new St.BoxLayout({style: `padding: 4px 10px; width: ${ROW_W}px;`});
        addRow.add_child(new St.Label({
            text: 'Add client…',
            opacity: DIM_OPACITY,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; font-weight: 500;',
        }));
        this._rowButton(menu, addRow).connect('clicked', () => this._onAddClient?.());
    }

    // One row, laid out like the usage rows above (usageRows.js): the same
    // padding, content width and font sizes, so the names line up. The
    // play/pause icon sits at the right, before the time, well away from a
    // client's expander arrow, and shows what a tap does.
    _addRow(menu, { text, bold, depth, secs, state = null, arrow = null, onTap }) {
        let indent = depth * INDENT;
        let row = new St.BoxLayout({
            style: `padding: 4px 10px 4px ${10 + indent}px; width: ${ROW_W - indent}px;`,
        });
        let label = new St.Label({
            text,
            y_align: Clutter.ActorAlign.CENTER,
            style: `font-size: 11px; font-weight: ${bold ? 700 : 500};`,
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(label);
        if (arrow) {
            row.add_child(new St.Label({
                text: arrow,
                opacity: DIM_OPACITY,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 10px;',
            }));
        }
        row.add_child(new St.Widget({x_expand: true}));
        if (state) {
            let isRunning = state === 'running';
            row.add_child(new St.Icon({
                icon_name: isRunning ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
                icon_size: 10,
                opacity: isRunning ? 255 : DIM_OPACITY,
                y_align: Clutter.ActorAlign.CENTER,
                style: isRunning ? 'color: #c061cb;' : '',
            }));
        }
        row.add_child(new St.Label({
            text: secs > 0 ? formatTime(secs) : '—',
            opacity: DIM_OPACITY,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 10px; padding-left: 8px;',
        }));
        this._rowButton(menu, row).connect('clicked', onTap);
    }

    // Clocks `client` in on `project` (null is General), or pauses it when
    // that exact pair is already running. Re-derived at tap time rather than
    // closed over: the panel or shortcut can change the clock while the
    // popup is open.
    _tap(client, project, rebuild) {
        let current = this._clock.running;
        try {
            if (current?.client === client && current.project === project)
                this._clock.stop();
            else
                this._clock.start(client, Date.now(), { project });
        } catch (e) {
            // start()/stop() throw only when the system clock is out of
            // range; there is no toast in the popup, so log and leave
            // last-client and the rebuild alone rather than recording a
            // switch that never happened.
            console.error(`[ScreenTime] clock tap failed: ${e.message}`);
            return;
        }
        this._settings.set_string('last-client', client);
        this._settings.set_string('last-project', project ?? '');
        rebuild();
    }

    // Wraps `row` in the button-in-item shape described above build() and
    // appends it to `menu`. Returns the button for the caller to connect.
    _rowButton(menu, row) {
        let item = new PopupMenu.PopupBaseMenuItem({activate: false});
        item.track_hover = false;
        item.style = 'padding: 0;';
        let btn = new St.Button({
            child: row,
            can_focus: true,
            x_expand: true,
            style_class: 'screen-time-clock-row',
        });
        item.add_child(btn);
        menu.addMenuItem(item);
        return btn;
    }

    destroy() {
        this._clock = null;
        this._settings = null;
        this._onAddClient = null;
    }
}
