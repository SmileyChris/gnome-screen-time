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
export class ClockNotifier {
    constructor(clock, settings) {
        this._clock = clock;
        this._settings = settings;
        this._source = null;
        this._active = null;
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
        });
        Main.messageTray.add(this._source);
        return this._source;
    }

    _show(title, body, actions) {
        let source = this._ensureSource();
        if (this._active) {
            this._active.title = title;
            this._active.body = body;
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
                        this._active?.destroy();
                        return;
                    }
                    try {
                        this._clock.update(session.id, { endMs: awaySinceMs });
                    } catch (e) {
                        console.error(`[ScreenTime] idle nudge: could not stop the clock ` +
                            `at ${at}: ${e.message}`);
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
                        this._active?.destroy();
                        return;
                    }
                    let client = session.client;
                    let closed = false;
                    try {
                        this._clock.update(session.id, { endMs: sleptAtMs });
                        closed = true;
                    } catch (e) {
                        console.error('[ScreenTime] resume nudge: could not trim sleep ' +
                            `from the clock: ${e.message}`);
                    }
                    if (closed) {
                        try {
                            this._clock.start(client, wokeAtMs);
                        } catch (e) {
                            console.error('[ScreenTime] resume nudge: sleep was trimmed but ' +
                                `the clock could not be restarted for ${client}: ${e.message}`);
                        }
                    }
                    this._active?.destroy();
                }],
                ['Keep it', () => this._active?.destroy()],
            ]);
    }

    notifyInterrupted(session) {
        let at = new Date(session.endMs).toTimeString().slice(0, 5);
        this._show(
            `Clock for ${session.client} stopped at ${at}`,
            'The Shell went away while the clock was running. Check it in the Timesheet.',
            [['Dismiss', () => this._active?.destroy()]]);
    }

    destroy() {
        this._active?.destroy();
        this._active = null;
        this._source?.destroy();
        this._source = null;
        this._clock = null;
        this._settings = null;
    }
}
