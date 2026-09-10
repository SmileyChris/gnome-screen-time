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
| Show total time in panel | On | Off shows only the icon. |
| Max interval | 600s | Caps any single tracked stretch, so a stall can't dump hours onto one app. |
| Idle timeout | 10 min | Stop counting after this long without input. `0` disables idle detection. |
| Day starts at | 0 (midnight) | Hour a new day begins, so work past midnight can stay on the day it started. |
| App time limits | none | Per-app daily limit in minutes; notifies once per day when crossed. |
| Retention days | 90 | How long history is kept. `0` keeps it forever. |

## How time is measured

Time is attributed to the app owning the **focused window**, updated on every focus change and every 30 seconds. Some consequences worth knowing:

- A video playing in an **unfocused** window is not counted: this measures interaction, not playback.
- Tracking **stops** when the screen blanks, when the session locks, and across suspend. It resumes from the moment you come back, so the gap belongs to nobody.
- After **10 minutes without keyboard or mouse input** (Idle Timeout in preferences, 0 to disable) counting stops even if the screen stays on, unless something is inhibiting idle the way a playing video does, and resumes on the next input. Time up to the timeout is still counted, so a walk-away costs at most one timeout of over-count.
- Apps without a `.desktop` file (typically AppImages) are identified by their window class, so their history accumulates instead of splitting across launches.
- Inside a **terminal running zellij**, time is further broken down by the focused pane's command and working directory (for example `claude` in `gnome-screen-time`), read from `zellij action dump-layout`. Only the session name is read from the window title; the pane title is never stored. Terminals not running zellij, and terminals not on the built-in list, are tracked as a single app. The zellij binary must be on GNOME Shell's PATH (a systemd user session often lacks ~/.cargo/bin and ~/.local/bin); if it is not found, terminals are tracked as a single app. Zellij sets the window title only when the focused pane's title changes, so a terminal that has just attached to an idle session stays at the app level until something in that pane retitles it.
- In **Brave, Chrome, Firefox and Zen**, with the companion WebExtension installed (see `companion/README.md`), time is further broken down by site and, for code hosts and reddit, by repository or subreddit. Only the site and a short path key (one segment, or owner/repo on code hosts) leave the browser, over a local native-messaging host into the extension. Private windows are counted as the browser alone.
- A day runs from midnight by default. **Day Starts At** in preferences moves that boundary, so 4 keeps work between midnight and 4am on the day it started rather than opening a new one. Changing it is not retroactive: time already filed under a date stays there.

## Data

Usage is stored at:

```
~/.local/share/gnome-shell/screen-time/usage.json
```

It is keyed by date, then by app, where the date is the logical day set by **Day Starts At**. An app may carry a `children` map (activity, then detail) when a breakdown source applies; the app's own `seconds` is always the total including its children, so older versions read the file as plain per-app data. Each parent keeps at most 20 named children per day; the rest fold into an `__other__` entry. Click the total card to switch the bars between share of the total and share of the largest row at that level; the percentages always show share of the parent. Long-press a row in the popup to edit it: leaves get a slider (Save, or Delete at zero); a parent expands, shows its own unattributed time, and offers Delete all. Undo edit in the popup footer reverts the last edit on that day until the next edit or a Shell restart. Delete the file to reset everything, or use **Delete data older than 7 days** in preferences. Anything older than the retention setting is removed automatically.

## Development

```
src/        extension sources, metadata.json, stylesheet.css, schemas/
companion/  browser companion: WebExtension, native host, build tool
dist/       packaged release archive (build output)
assets/     screenshots
```

```bash
make            # compile the GSettings schema
make install    # install to ~/.local/share/gnome-shell/extensions/
make reload     # load src/ into the running Shell under a fresh dev UUID (no logout)
make unreload   # back to the installed production copy
make uninstall
make check      # syntax-check every module + validate metadata.json and the companion manifests
make test       # unit tests under plain gjs (tests/)
make pack       # build dist/screen-time@gnome-screen-time.shell-extension.zip
make clean
make companion-build      # build the browser companion for Brave and Zen
make companion-install    # register its native host with both browsers
```

`make check` uses `gjs -m`. Note that `gjs -c` runs a string and does **not** check syntax. `ImportError` for `resource:///org/gnome/...` and missing `Shell` typelibs are expected outside a live Shell; only `SyntaxError` counts as a failure.

GNOME 45+ caches an extension's modules for the life of the Shell, so re-enabling never picks up new code and Wayland cannot restart the Shell in place. `make reload` sidesteps both: it copies `src/` under a new dev UUID, disables the production copy, and asks the running Shell to load the new one through `org.gnome.Shell.Eval`. Eval answers only while Looking Glass's Unsafe Mode is on (Alt+F2, `lg`, the toggle in its top bar), once per login; turn it off when you are done iterating. `make unreload` removes the dev copy and re-enables the production UUID; `make install` does the same automatically, so finishing a dev session is just `make install`.

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
