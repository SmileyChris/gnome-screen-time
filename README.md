# Screen Time

A GNOME Shell extension that tracks how long you spend in each app, macOS Screen Time style.

The panel shows today's total at a glance. Click it for a per-app breakdown, and step back through previous days one at a time.

![Screen Time popup](assets/Look.gif)

> **This is a fork** of [itsDigvijaysing/gnome-screen-time](https://github.com/itsdigvijaysing/gnome-screen-time), which is the original and where the design came from. It tracks upstream and adds idle detection, a breakdown of time *within* an app (terminal panes, browser sites), and editing of recorded entries. Some of that is [open upstream as pull requests](https://github.com/itsDigvijaysing/gnome-screen-time/pulls); the rest lives here.
>
> It keeps the original's extension UUID on purpose, so it installs **over** the original as a drop-in replacement rather than running alongside it. Both versions read the same `usage.json`, so switching either way keeps your history. If you also have the original installed from extensions.gnome.org, an update from there will replace this one; re-run `make install` to come back.

## Features

- **Panel indicator:** today's total next to the clock, or just the icon if you prefer.
- **Per-app breakdown:** top five apps with usage bars and percentages; everything else folds into a collapsible "Other N apps" row, so the numbers always add up to the total.
- **Day-by-day history:** `‹ Today ›` steps back one day at a time.
- **App time limits:** set a daily limit per app and get a desktop notification once you cross it.
- **7-day chart** in preferences, with configurable retention and a one-click purge.
- **Presence-aware:** time on the lock screen, while the screen is blanked, or while suspended is never counted.
- **Idle detection:** counting stops after 10 minutes without keyboard or mouse input, unless something is inhibiting idle the way a playing video does.
- **Activity breakdown:** inside a terminal running [zellij](https://zellij.dev), time splits by the focused pane's command and working directory; in Brave, Chrome, Firefox and Zen with the companion extension, by site and repository or subreddit. Expand any row to see it.
- **Editable history:** long-press a row to correct it with a slider, delete it, or delete a whole app's day, with one level of undo.
- **Client clock:** clock in and out per client from the panel or a keyboard shortcut, with the recorded activity kept beside each session as evidence so billed hours can be adjusted against what actually happened.
- **Timesheet window:** review sessions, see what was on screen during each one, adjust the hours, and export a period as JSON or CSV shaped for an invoicing system.
- **Local only:** a plain JSON file on your disk. No network access, no telemetry. The browser companion sends only the site and a short path key, over a local native-messaging host.

## Requirements

GNOME Shell 47, 48, 49 or 50. X11 or Wayland.

## Install

```bash
git clone https://github.com/SmileyChris/gnome-screen-time
cd gnome-screen-time
make install
```

Then reload GNOME Shell and enable it:

- **Wayland:** log out and back in (there is no in-session reload).
- **X11:** press `Alt`+`F2`, type `r`, press `Enter`.

```bash
gnome-extensions enable screen-time@gnome-screen-time
```

## Preferences

Open from the gear icon at the bottom of the popup, or:

```bash
gnome-extensions prefs screen-time@gnome-screen-time
```

![Settings](assets/Settings.png)

## Settings

| Setting | Default | What it does |
|---|---|---|
| Show in panel | Screen time | *Screen time* shows today's total; *Client time* shows the running session's own elapsed time, or today's billed total once it's stopped; *Nothing* shows only the icon. A dot marks a running clock in every mode. |
| Max interval | 600s | Caps any single tracked stretch, so a stall can't dump hours onto one app. |
| Idle timeout | 10 min | Stop counting after this long without input. `0` disables idle detection. |
| Day starts at | 0 (midnight) | Hour a new day begins, so work past midnight can stay on the day it started. |
| App time limits | none | Per-app daily limit in minutes; notifies once per day when crossed. |
| Retention days | 90 | How long history is kept. `0` keeps it forever. |
| Clients | none | Who the clock can bill to. Non-billable clients are tracked but left out of exports; inactive ones stay out of the popup but stay exportable. Deleting a client (rather than turning it inactive) asks for confirmation, since it stops any of its recorded sessions from being exported again unless the same name is added back. |
| Toggle the clock | unset | Keyboard shortcut that stops the clock, or starts the client you used last. |
| Nudge when idle | 30 min | Minutes idle on the clock before a notification offers to stop it. `0` disables it. |
| Evidence retention | 30 days | How long the activity timeline behind each session is kept. Sessions are never deleted. `0` keeps it forever. |

## How time is measured

Time is attributed to the app owning the **focused window**, updated on every focus change and every 30 seconds. Some consequences worth knowing:

- A video playing in an **unfocused** window is not counted: this measures interaction, not playback.
- Tracking **stops** when the screen blanks, when the session locks, and across suspend. It resumes from the moment you come back, so the gap belongs to nobody.
- After **10 minutes without keyboard or mouse input** (Idle Timeout in preferences, 0 to disable) counting stops even if the screen stays on, unless something is inhibiting idle the way a playing video does, and resumes on the next input. Time up to the timeout is still counted, so a walk-away costs at most one timeout of over-count.
- Apps without a `.desktop` file (typically AppImages) are identified by their window class, so their history accumulates instead of splitting across launches.
- Inside a **terminal running zellij**, time is further broken down by the focused pane's command and working directory (for example `claude` in `gnome-screen-time`), read from `zellij action dump-layout`. Only the session name is read from the window title; the pane title is never stored. Terminals not running zellij, and terminals not on the built-in list, are tracked as a single app. The zellij binary must be on GNOME Shell's PATH (a systemd user session often lacks ~/.cargo/bin and ~/.local/bin); if it is not found, terminals are tracked as a single app. Zellij sets the window title only when the focused pane's title changes, so a terminal that has just attached to an idle session stays at the app level until something in that pane retitles it.
- In **Brave, Chrome, Firefox and Zen**, with the companion WebExtension installed (see `companion/README.md`), time is further broken down by site and, for code hosts and reddit, by repository or subreddit. Only the site and a short path key (one segment, or owner/repo on code hosts) leave the browser, over a local native-messaging host into the extension. Private windows are counted as the browser alone.
- A day runs from midnight by default. **Day Starts At** in preferences moves that boundary, so 4 keeps work between midnight and 4am on the day it started rather than opening a new one. Changing it is not retroactive: time already filed under a date stays there.

## The client clock

Clock in to a client from the popup, the panel's Start/Stop button, or a keyboard shortcut. Only one client runs at a time: starting a different one stops the current session and starts the next in the same action.

- **Panel:** *Client time* shows the running session's own elapsed time (not the day's total, so switching clients shows the new one's time from zero), today's billed total, faded, while paused, and nothing once stopped. A dot marks a running clock in every mode, hollow while you're away and filled otherwise.
- **Popup:** the clock card sits beside the screen time card at the top, purple while a clock is running and gray otherwise. Running, it shows the client and that client's time today, with a pause button; paused, the same with stop and play buttons. Tapping the card itself also pauses or resumes. Stop ends the session too, but forgets the client: the card then shows today's billed total and can't resume, and the panel hides the time until you pick a client from the rows below. Pausing and stopping both close the session the same way; the difference is only what resumes. The keyboard shortcut and DBus `StopSession` pause. The clock rows, and the card's client and controls, only show for today. Paging back to an earlier day replaces them with that day's already-billed total and no controls.
- **Under a minute:** a session that ends less than a minute after it started - a mis-tap, or a client you switched away from straight away - is dropped rather than kept, unless you gave it billed hours or a note. That holds however it ends, crash recovery and logout included. Sessions like this saved before this rule existed are cleared out the next time the clock loads; an exported session is always kept.
- **Keyboard shortcut:** unset by default. Any bare key that types a character - letters in any script, digits, space, punctuation and symbols, not just the Latin/ASCII set - plus the navigation and editing keys (arrows, Tab, Home/End, Page Up/Down, Enter, BackSpace, Delete, Insert), the same held with Shift alone, and a modifier pressed on its own are all refused as bindings, since any of them would otherwise break typing, selection or navigation everywhere else. Bare function keys and media keys are still accepted, matching GNOME's own defaults.
- **Idle nudge:** once the clock has run this long without input, a notification offers **Stop at HH:MM** (closes the session at the moment you went idle) or **Keep running**. Only fires while the extension is actually enabled - see Lock/idle blank/suspend below for when it isn't.
- **Suspend:** waking up while clocked in, without the screen having locked, offers **Trim sleep** (closes the session at the moment it slept and reopens the same client at the moment it woke, so the sleep itself is never billed) or **Keep it**.
- **Lock, idle blank, and suspend-with-lock:** GNOME Shell disables every extension without `session-modes` in `metadata.json` - this one included - the instant the session locks, the idle screen blanks (even with locking turned off), or a suspend with lock-on-suspend begins, and re-enables it on unlock. The clock keeps running through all of it rather than stopping, but nothing can nudge you while the extension itself is disabled - there is no idle nudge and no suspend nudge in this window. Unlocking instead shows how long you were away (from whichever came first: the tracker noticing you'd gone, or the last heartbeat before the lock), past the same idle-nudge threshold, with **Stop at HH:MM**, **Trim away time** (closes the session at the away moment and immediately starts the same client again, so the away time isn't billed), or **Keep running**.
- **Crash recovery:** disabling and re-enabling this extension within the same GNOME Shell session - a lock, an idle blank, a suspend that locks - resumes the exact same session regardless of how long that lasted, since the Shell keeps this extension's own state alive across the cycle. A genuine restart of the Shell process itself - a crash, `make reload` (a fresh dev UUID means fresh state, so this counts as a restart here, not a resume), a real logout/login, a reboot - has no such memory: a session still open the next time this extension enables is resumed if the gap since its last heartbeat is under two minutes, otherwise it's closed at that heartbeat and announced in a notification. A real logout or shutdown closes the session cleanly first, when the Shell gets the chance to run its shutdown handler before exiting; if it doesn't, the next login finds the session open and closes it the same way, at its last heartbeat.
- **Timesheet:** opened from the popup's footer, it lists sessions from the first day of last month to now, grouped by day - the same range "Last month" can export, so the start of a period reachable by export is never out of view here. Expanding one shows the recorded activity behind it (from the interval log) and its Started/Ended times, which accept `HH:MM` and resolve to whichever of the day before, the same day, or the day after is closest to the field's current value, so a start can move back across midnight. Snap buttons move the start to the first recorded activity or to the end of the session before it. **Bill** takes an hours override; **Use actual** clears it back to the clock's own time; **Save** sends only what you actually changed, and an edit you haven't saved yet survives the window refreshing under you.
- **Export:** from the Timesheet, **Last month** or **This month** as JSON or CSV, chosen by the file's extension: one row per client per day, keyed by a stable `screen-time:{client}:{date}` id that the invoicing side must upsert on, so exporting the same period again is how a correction reaches it. A day with zero billable hours is still exported, as `0`. If any closed session in the period belongs to a client no longer on the list at all (deleted, not merely made inactive or non-billable), the toast says how many were skipped. Re-export can't fix everything, though: deleting every session for a client-day, marking a client non-billable after it was exported, or renaming a client all leave a stale row behind on the invoicing side with nothing in a later export to correct it. Moving an exported session's start to a different day is refused outright rather than left to cause this: it would create a new day's row on the next export while the old day's row on the invoicing side kept its hours, billing it twice. Change it in the invoicing app first, or adjust the hours/note instead, both of which stay editable after export.

## Data

Usage is stored at:

```
~/.local/share/gnome-shell/screen-time/usage.json
```

It is keyed by date, then by app, where the date is the logical day set by **Day Starts At**. An app may carry a `children` map (activity, then detail) when a breakdown source applies; the app's own `seconds` is always the total including its children, so older versions read the file as plain per-app data. Each parent keeps at most 20 named children per day; the rest fold into an `__other__` entry. Click the screen time card to switch the bars between share of the total and share of the largest row at that level; the percentages always show share of the parent. Long-press a row in the popup to edit it: leaves get a slider (Save, or Delete at zero); a parent expands, shows its own unattributed time, and offers Delete all. Undo edit in the popup footer reverts the last edit on that day until the next edit or a Shell restart. Delete the file to reset everything, or use **Delete data older than 7 days** in preferences. Anything older than the retention setting is removed automatically.

The clock keeps two more files beside it. `clock.json` holds one record per session: client, day, start and end, the adjusted hours if you changed them, and the note. Sessions are never deleted automatically: they are the billing record. `clock.json` is never silently discarded: if it can't be read at all, the clock keeps running from memory but stops writing to it, so nothing already on disk is ever overwritten; if it can be read but not parsed, or holds an invalid record, the original bytes are backed up first, as `clock.json.invalid-<unix-seconds>`, before the clock carries on with whatever sessions could still be salvaged (none, if the whole file was invalid). `intervals/YYYY-MM-DD.ndjson` is the evidence behind them, one append-only file per day holding what was on screen and when, pruned on its own retention setting. An old session therefore keeps its hours and loses its breakdown. **Delete data older than 7 days** in preferences purges this too, not just the usage totals: it is a timestamped timeline of everything that was on screen, at least as sensitive as the totals.

Time is attributed by the clock, not by the screen tracking: a session's billed hours are its own start and end (or your override), never derived from what the interval log recorded. The breakdown is there to adjust against, which is why both the adjusted hours and the actual time on the clock are kept side by side in the Timesheet. Time with no focused window at all (the desktop, the overview, being away) shows as "unattributed" rather than idle, and undercounts a walk-away by up to one idle timeout, since time before the idle watch fires is still credited to the last focused app. A timestamp outside the year 2000-2100 is refused outright rather than recorded, so a machine whose clock has reset can't silently corrupt a session's start or end.

## Development

```
src/                     extension sources, metadata.json, stylesheet.css, schemas/
src/timesheetWindow.js   the standalone GTK4 Timesheet window (review, adjust, export)
src/timesheet.js         its launcher (gjs -m); not loaded by the Shell
companion/               browser companion: WebExtension, native host, build tool
dist/                    packaged release archive (build output)
assets/                  screenshots
```

```bash
make            # compile the GSettings schema
make install    # install to ~/.local/share/gnome-shell/extensions/
make reload     # load src/ into the running Shell under a fresh dev UUID (no logout)
make unreload   # back to the installed production copy
make uninstall
make check      # syntax-check every module + validate metadata.json and the companion manifests
make test       # unit tests under plain gjs (tests/), then tests/install.sh
make pack       # build dist/screen-time@gnome-screen-time.shell-extension.zip
make clean
make companion-build      # build the browser companion for Brave and Zen
make companion-install    # register its native host with both browsers
```

`make check` uses `gjs -m`. Note that `gjs -c` runs a string and does **not** check syntax. `ImportError` for `resource:///org/gnome/...` and missing `Shell` typelibs are expected outside a live Shell; only `SyntaxError` counts as a failure. `src/timesheet.js` is left out of the loop: running it would actually open a GTK window. `src/timesheetWindow.js`, which holds all its logic, is still checked.

GNOME 45+ caches an extension's modules for the life of the Shell, so re-enabling never picks up new code and Wayland cannot restart the Shell in place. `make reload` sidesteps both: it copies `src/` under a new dev UUID, disables the production copy, and asks the running Shell to load the new one through `org.gnome.Shell.Eval`. Eval answers only while Looking Glass's Unsafe Mode is on (Alt+F2, `lg`, the toggle in its top bar), once per login; turn it off when you are done iterating. `make unreload` removes the dev copy and re-enables the production UUID; `make install` does the same automatically, so finishing a dev session is just `make install`.

`make install` replaces the installed copy by renaming a freshly-built staging copy into place, never by overwriting files in it: a running Shell memory-maps the compiled schema, and overwriting those bytes in place crashed a live session on 2026-09-11. If the final rename fails, the previous install is put straight back rather than left half-replaced. `tests/install.sh`, which `make test` also runs, is a regression test for exactly that swap, entirely inside a scratch directory rather than the real installation.

Set `GNOME_SHELL_EXTENSION_SCREEN_TIME_DEBUG=1` in the Shell's environment (`systemctl --user set-environment ...`, then log in again) to log the resolved path on every focus change:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep ScreenTime
```

The packaged archive is validated with [shexli](https://pypi.org/project/shexli/) before release:

```bash
shexli dist/screen-time@gnome-screen-time.shell-extension.zip   # expects: clean (0 findings)
```

## License

[GPL-3.0](LICENSE)
