import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import { formatTime } from './formatTime.js';

// limitNotifier uses Main.notify, which cannot carry buttons. These need
// them, so they go through a Source of their own - and the repeat updates
// the same notification instead of stacking new ones.
//
// Verified against GNOME Shell 50's real
// /org/gnome/shell/ui/messageTray.js (extracted read-only from
// /usr/lib/gnome-shell/libshell-18.so; line numbers below are from that
// extract, cross-checked against messageList.js from the same resource and
// against a real extension - /usr/share/gnome-shell/extensions/
// arcmenu@arcmenu.com/updateNotifier.js - that branches on shell version 46):
//  - messageList.js:278-304: `MessageTray.Source` (`class Source extends
//    MessageList.Source`) is constructed from a params object with GObject
//    properties `title` and `icon-name` (camelCase `iconName` accepted, as
//    arcmenu's `new MessageTray.Source({title, iconName})` does).
//  - messageTray.js:507-627: `Source`'s only ways to show a notification are
//    `addNotification(notification)` (line 579) and the request-banner
//    signal chain below; there is no `showNotification` method any more (it
//    was removed between 45 and 46 - the plan's code, written from memory,
//    still called it).
//  - messageTray.js:630-699: `Notification`'s `title` and `body` (636-643)
//    are plain READWRITE string properties with no custom setter, so
//    assigning `notification.title = ...` on a still-open notification is
//    enough to change what every bound display (the banner, the calendar
//    row) shows - confirmed by messageList.js:704-708, which binds a
//    displayed message's `title`/`body` straight to the notification's.
//  - messageTray.js:1166-1167 (`_updateShowingNotification`): the instant a
//    notification is actually shown as a banner, `acknowledged` is set to
//    `true`.
//  - messageTray.js:589-595 (`Source.addNotification`): a `notify::
//    acknowledged` handler re-emits `notification-request-banner` only when
//    `acknowledged` becomes `false`; messageTray.js:876-882 has the tray
//    listening for that signal on every added source. So "update in place
//    and pop back up as a banner" needs the repeat to explicitly set
//    `acknowledged = false` again - simply changing title/body updates a
//    notification already parked in the tray but does not re-request a
//    banner on its own.
//  - messageTray.js:428-447 (`Notification.addAction`): wraps each callback
//    so a *non*-resident notification auto-destroys itself after any action
//    fires; `resident: true` (used below) opts out so the Stop/Trim/Dismiss
//    handlers control destruction themselves.
//  - messageTray.js:458-465 (`Notification.clearActions`): removes every
//    action, emitting `action-removed` for each; messageList.js:695-697
//    connects a displayed notification's `action-added`/`action-removed` to
//    messageList.js:739-767's `_addAction`/`_removeAction`, which add or
//    destroy the actual button. So `clearActions()` + `addAction()` on an
//    already-shown, still-open notification redraws its button row live -
//    this is what `_show()`'s update path uses below to keep the buttons in
//    sync with whichever text is currently showing.
export class ClockNotifier {
    constructor(clock) {
        this._clock = clock;
        this._source = null;
        this._active = null;
        // A second, independent resident notification from this._active
        // (the idle/suspend/away nudges): save-health is a standing
        // condition, not a moment-in-time prompt, and must not clobber - or
        // be clobbered by - whichever nudge happens to be showing. See
        // syncSaveHealth() below.
        this._saveHealthNotice = null;
    }

    _ensureSource() {
        if (this._source)
            return this._source;
        this._source = new MessageTray.Source({
            title: 'Screen Time',
            iconName: 'alarm-symbolic',
        });
        this._source.connect('destroy', () => {
            this._source = null;
            this._active = null;
            this._saveHealthNotice = null;
        });
        Main.messageTray.add(this._source);
        return this._source;
    }

    // Every call installs exactly the actions for the text it is showing -
    // both the create path and the update path always run the same
    // addAction loop, never leaving a previous call's buttons (and the
    // session/timestamps their closures captured) behind under new text.
    _show(title, body, actions) {
        let source = this._ensureSource();
        if (this._active) {
            this._active.title = title;
            this._active.body = body;
            // clearActions() + addAction() (see the class comment for the
            // exact source lines) redraws the live button row rather than
            // leaving stale buttons - and stale closures - under new text:
            // without this, a nudge left on screen across a second idle
            // spell (or a different notice arriving while one is still up)
            // would keep acting on the first spell's session/timestamps.
            this._active.clearActions();
            for (let [label, fn] of actions)
                this._active.addAction(label, fn);
            // Flips true -> false, which is what actually re-requests the
            // banner (see the class comment above) rather than just
            // updating a notification already sitting in the tray.
            this._active.acknowledged = false;
            return;
        }
        let notification = new MessageTray.Notification({
            source, title, body,
            urgency: MessageTray.Urgency.NORMAL,
            resident: true,
        });
        for (let [label, fn] of actions)
            notification.addAction(label, fn);
        notification.connect('destroy', () => { this._active = null; });
        this._active = notification;
        source.addNotification(notification);
    }

    // `session` is the running session as of the moment the nudge fired; if
    // the clock has since moved on (stopped, switched client) the actions
    // below become no-ops rather than mutating whatever happens to be
    // running now or an already-closed session.
    _isStillRunning(session) {
        return this._clock?.running?.id === session.id;
    }

    // A button whose action didn't actually happen must not just vanish the
    // way a successful one does - that reads as success. Goes through
    // _show() (with a single Dismiss action) so the stale buttons are
    // replaced rather than left under a now-wrong message, and so the
    // explanation pops back up as a banner even if the original nudge had
    // already faded into the tray.
    _showFailure(title, body) {
        this._show(title, body, [['Dismiss', () => this._active?.destroy()]]);
    }

    // ClockStore._save() logs a failure and carries on, so a billing edit
    // could sit unpersisted in memory with every caller reporting success
    // and nothing but the journal to say otherwise - and after C1, anything
    // held only in memory is lost the moment a real logout/shutdown closes
    // this Shell process. Call this whenever the clock might have changed
    // state (extension.js does so from clock.onChange and from the 30s
    // heartbeat tick, since heartbeat()'s own save doesn't fire onChange).
    //
    // "Don't spam": a resident notice is created once, the moment either
    // condition starts, and left alone - not re-shown, not re-acknowledged
    // - while it continues; only its body text is refreshed in place if the
    // reason changes (read-only vs. a save failure). It is destroyed the
    // moment a later call finds everything healthy again. A user dismissal
    // in between is respected until the state actually clears and returns.
    syncSaveHealth() {
        let reason = null;
        if (this._clock?.readOnly)
            reason = "clock.json couldn't be read, so changes are kept in memory only " +
                "and won't survive a restart.";
        else if (this._clock?.saveFailing)
            reason = 'The last save to clock.json failed - see the logs for why.';

        if (reason === null) {
            this._saveHealthNotice?.destroy();
            this._saveHealthNotice = null;
            return;
        }
        if (this._saveHealthNotice) {
            this._saveHealthNotice.body = reason;
            return;
        }
        let source = this._ensureSource();
        let notification = new MessageTray.Notification({
            source,
            title: "Clock changes aren't being saved",
            body: reason,
            urgency: MessageTray.Urgency.NORMAL,
            resident: true,
        });
        notification.connect('destroy', () => {
            if (this._saveHealthNotice === notification)
                this._saveHealthNotice = null;
        });
        this._saveHealthNotice = notification;
        source.addNotification(notification);
    }

    // `awaySeconds` is for display only; `awaySinceMs` is the tracker's own
    // `_awaySince` instant and is what Stop actually closes the session at -
    // billing "now" would charge every minute of the very idle spell this
    // nudge exists to catch. Away is only detected one idle-timeout after
    // the last input (see UsageTracker), so up to that much inactivity is
    // still billed even after Stop; that margin is `idle-timeout`, not a
    // bug here.
    notifyIdle(session, awaySeconds, awaySinceMs) {
        let at = new Date(awaySinceMs).toTimeString().slice(0, 5);
        this._show(
            `Still on the clock for ${session.client}`,
            `Idle for ${formatTime(awaySeconds)}. The clock is still running.`,
            [
                [`Stop at ${at}`, () => {
                    if (!this._isStillRunning(session)) {
                        console.debug('[ScreenTime] idle nudge: Stop clicked after the ' +
                            'clock already moved on; nothing to do');
                        this._showFailure(`${session.client}'s clock has moved on`,
                            "That session isn't running any more - nothing to stop here.");
                        return;
                    }
                    try {
                        this._clock.update(session.id, { endMs: awaySinceMs });
                    } catch (e) {
                        console.error(`[ScreenTime] idle nudge: could not stop the clock ` +
                            `at ${at}: ${e.message}`);
                        this._showFailure(`Couldn't stop the clock for ${session.client}`,
                            "Couldn't stop the clock automatically - stop it from the panel.");
                        return;
                    }
                    this._active?.destroy();
                }],
                ['Keep running', () => this._active?.destroy()],
            ]);
    }

    // "Trim sleep" cuts the sleep out without stopping the work: close the
    // running session at the moment suspend began (`sleptAtMs`, the
    // tracker's `_sleptAt`) and reopen the same client at the moment it
    // actually woke (`wokeAtMs`) - not "now", which is whenever the user
    // happens to click the button and would otherwise strand the time
    // between waking and clicking as untracked.
    notifyResume(session, sleptSeconds, sleptAtMs, wokeAtMs) {
        this._show(
            `Still on the clock for ${session.client}`,
            `Asleep for ${formatTime(sleptSeconds)}, which is still on the clock.`,
            [
                ['Trim sleep', () => {
                    if (!this._isStillRunning(session)) {
                        console.debug('[ScreenTime] resume nudge: Trim sleep clicked after ' +
                            'the clock already moved on; nothing to do');
                        this._showFailure(`${session.client}'s clock has moved on`,
                            "That session isn't running any more - nothing to trim here.");
                        return;
                    }
                    let client = session.client;
                    try {
                        this._clock.update(session.id, { endMs: sleptAtMs });
                    } catch (e) {
                        console.error('[ScreenTime] resume nudge: could not trim sleep ' +
                            `from the clock: ${e.message}`);
                        this._showFailure(`Couldn't trim sleep for ${client}`,
                            'Couldn\'t trim sleep from the clock automatically - stop it ' +
                            'from the panel.');
                        return;
                    }
                    try {
                        this._clock.start(client, wokeAtMs);
                    } catch (e) {
                        console.error('[ScreenTime] resume nudge: sleep was trimmed but ' +
                            `the clock could not be restarted for ${client}: ${e.message}`);
                        this._showFailure(`${client}'s clock wasn't restarted`,
                            'The sleep was trimmed, but the clock could not be restarted ' +
                            'automatically - start it again from the panel.');
                        return;
                    }
                    this._active?.destroy();
                }],
                ['Keep it', () => this._active?.destroy()],
            ]);
    }

    // Surfaced once, on the enable() that follows a disable() which left a
    // session running (a lock, an idle blank, or a suspend that disabled the
    // extension - see extension.js's module-scoped heldSessionId): the
    // reachability the idle and suspend nudges lose while the extension
    // itself is disabled and cannot run a timer or listen for anything.
    // `awaySinceMs` is the away-on-unlock moment (nudge.js's awayMomentMs),
    // not "now" - billing every minute of the very away spell this notice
    // exists to catch would defeat the point of it.
    notifyAway(session, awaySinceMs, nowMs = Date.now()) {
        let at = new Date(awaySinceMs).toTimeString().slice(0, 5);
        let awaySeconds = Math.max(0, Math.round((nowMs - awaySinceMs) / 1000));
        this._show(
            `Still on the clock for ${session.client}`,
            `Away for ${formatTime(awaySeconds)} while the extension was off (locked, blanked, ` +
            'or asleep). The clock kept running.',
            [
                [`Stop at ${at}`, () => {
                    if (!this._isStillRunning(session)) {
                        console.debug('[ScreenTime] away nudge: Stop clicked after the ' +
                            'clock already moved on; nothing to do');
                        this._showFailure(`${session.client}'s clock has moved on`,
                            "That session isn't running any more - nothing to stop here.");
                        return;
                    }
                    try {
                        this._clock.update(session.id, { endMs: awaySinceMs });
                    } catch (e) {
                        console.error(`[ScreenTime] away nudge: could not stop the clock ` +
                            `at ${at}: ${e.message}`);
                        this._showFailure(`Couldn't stop the clock for ${session.client}`,
                            "Couldn't stop the clock automatically - stop it from the panel.");
                        return;
                    }
                    this._active?.destroy();
                }],
                ['Trim away time', () => {
                    if (!this._isStillRunning(session)) {
                        console.debug('[ScreenTime] away nudge: Trim away time clicked after ' +
                            'the clock already moved on; nothing to do');
                        this._showFailure(`${session.client}'s clock has moved on`,
                            "That session isn't running any more - nothing to trim here.");
                        return;
                    }
                    let client = session.client;
                    try {
                        this._clock.update(session.id, { endMs: awaySinceMs });
                    } catch (e) {
                        console.error('[ScreenTime] away nudge: could not trim away time ' +
                            `from the clock: ${e.message}`);
                        this._showFailure(`Couldn't trim away time for ${client}`,
                            'Couldn\'t trim away time from the clock automatically - stop it ' +
                            'from the panel.');
                        return;
                    }
                    try {
                        this._clock.start(client, nowMs);
                    } catch (e) {
                        console.error('[ScreenTime] away nudge: away time was trimmed but ' +
                            `the clock could not be restarted for ${client}: ${e.message}`);
                        this._showFailure(`${client}'s clock wasn't restarted`,
                            'Away time was trimmed, but the clock could not be restarted ' +
                            'automatically - start it again from the panel.');
                        return;
                    }
                    this._active?.destroy();
                }],
                ['Keep running', () => this._active?.destroy()],
            ]);
    }

    // With this fix, the extension staying running through a lock/blank/
    // suspend (and disable() no longer closing the session - see
    // extension.js) means this is never what a lock looks like: it only
    // fires when the Shell itself went away without a clean goodbye (a
    // crash, or a real logout/shutdown whose 'shutdown' signal either
    // didn't fire in time or wasn't connected - see extension.js's
    // `global.connect('shutdown', ...)`), so it must not claim a crash
    // specifically.
    notifyInterrupted(session) {
        let at = new Date(session.endMs).toTimeString().slice(0, 5);
        this._show(
            `Clock for ${session.client} stopped at ${at}`,
            'The session ended while the clock was running. Check it in the Timesheet.',
            [['Dismiss', () => this._active?.destroy()]]);
    }

    destroy() {
        this._active?.destroy();
        this._active = null;
        this._saveHealthNotice?.destroy();
        this._saveHealthNotice = null;
        this._source?.destroy();
        this._source = null;
        this._clock = null;
    }
}
