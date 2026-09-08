import Gio from 'gi://Gio';
import { sessionFromTitle, focusedPane, basename } from './zellijLayout.js';
import { OTHER_KEY } from './usageStore.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

// At most one spawn per window in this many milliseconds. The tracker asks on
// every focus change and every 30s tick; rapid alt-tabbing must not fan out.
export const DEBOUNCE_MS = 5000;

// Terminals that host zellij. Anything not listed gets today's per-app
// tracking, never a wrong answer.
export const TERMINAL_APP_IDS = [
    'org.gnome.Console.desktop',
    'org.gnome.Terminal.desktop',
    'org.gnome.Ptyxis.desktop',
    'com.raggesilver.BlackBox.desktop',
    'kitty.desktop',
    'Alacritty.desktop',
    'com.mitchellh.ghostty.desktop',
    'org.wezfurlong.wezterm.desktop',
    'foot.desktop',
    'footclient.desktop',
    'org.codeberg.dnkl.foot.desktop',
    'org.kde.konsole.desktop',
    'com.gexperts.Tilix.desktop',
];

// Resolves a focused terminal window to zellij's focused pane: the running
// command is the activity, the cwd's basename is the detail. Reads only the
// session token from the window title; the rest of the title is work content
// and is never looked at.
export class ZellijSource {
    constructor() {
        this._binary = 'zellij';
        this._disabled = false;
        this._cancellable = new Gio.Cancellable();
    }

    claims(appId) {
        return TERMINAL_APP_IDS.includes(appId);
    }

    async resolve(win) {
        if (this._disabled)
            return null;
        let session = sessionFromTitle(win.get_title());
        if (!session)
            return null;
        // The token comes from a window title, which any program can set;
        // reject anything flag-like or implausibly long rather than pass it
        // through to argv unchecked.
        if (session.startsWith('-') || session.length > 128)
            return null;
        let layout = await this._dumpLayout(session);
        if (layout === null)
            return null;
        let pane = focusedPane(layout);
        if (!pane)
            return null;
        let command = pane.command || 'shell';
        let detail = pane.cwd ? basename(pane.cwd) : null;
        // A command or directory literally named "__other__" would otherwise
        // merge into the store's fold node for genuinely folded siblings.
        if (command === OTHER_KEY)
            command = '_other_';
        if (detail === OTHER_KEY)
            detail = '_other_';
        return {
            activityId: command, activityName: command,
            detailId: detail, detailName: detail,
        };
    }

    // argv for `zellij --session=<session> action dump-layout`. A method of
    // its own so it is testable without spawning.
    _argv(session) {
        return [this._binary, `--session=${session}`, 'action', 'dump-layout'];
    }

    // stdout of that command, or null. A spawn failure (binary missing, not
    // executable) disables the source for the rest of the session; a
    // non-zero exit (session gone) is per-call only.
    async _dumpLayout(session) {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                this._argv(session),
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.debug(`[ScreenTime] zellij unavailable, disabling source: ${e.message}`);
            this._disabled = true;
            return null;
        }
        try {
            // Gio._promisify drops the boolean, so the tuple is [stdout, stderr].
            let [stdout] = await proc.communicate_utf8_async(null, this._cancellable);
            if (!proc.get_successful())
                return null;
            return stdout;
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`[ScreenTime] zellij dump-layout failed: ${e.message}`);
            return null;
        }
    }

    destroy() {
        this._cancellable.cancel();
    }
}

// Picks the source that claims an app and debounces its resolves per window.
// Callers inside the debounce window get the cached (possibly still pending)
// promise, so concurrent askers never trigger a second spawn. A source that
// pushes state (the browser companion) reports changes through `onChange`;
// the registry drops its cache so the next resolve sees the new state, and
// forwards the event to the tracker.
export class ActivitySourceRegistry {
    constructor(sources = [new ZellijSource()]) {
        this._sources = sources;
        this._recent = new WeakMap();   // win -> { at, promise }
        this.onChange = null;
        for (let s of sources) {
            if ('onChange' in s)
                s.onChange = () => this._onSourceChanged();
        }
    }

    _onSourceChanged() {
        this._recent = new WeakMap();
        this.onChange?.();
    }

    resolve(win, appId, now = Date.now()) {
        let source = this._sources.find(s => s.claims(appId));
        if (!source)
            return Promise.resolve(null);

        let recent = this._recent.get(win);
        if (recent && now - recent.at < DEBOUNCE_MS)
            return recent.promise;

        let promise = source.resolve(win, appId).catch(e => {
            console.error(`[ScreenTime] activity resolve failed: ${e.message}`);
            return null;
        });
        this._recent.set(win, { at: now, promise });
        return promise;
    }

    destroy() {
        for (let s of this._sources)
            s.destroy?.();
        this._sources = [];
        this.onChange = null;
    }
}
