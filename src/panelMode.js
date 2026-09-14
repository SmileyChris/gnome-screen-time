// Pure panel-mode logic, kept out of St code so it can be unit tested
// without the Shell. Never import Shell/St/Clutter here.
import { formatTime } from './formatTime.js';

// Runs once: takes panel-time from the older show-total-in-panel boolean, then
// marks itself done so a later user choice is never overwritten.
export function migratePanelSetting(settings) {
    if (settings.get_boolean('panel-time-migrated'))
        return;
    settings.set_string('panel-time',
        settings.get_boolean('show-total-in-panel') ? 'screen' : 'none');
    settings.set_boolean('panel-time-migrated', true);
}

// The clock state PanelIndicator.setClock takes, derived from a real
// ClockStore. Running: the current session's own elapsed time - a live
// timer, so switching from ACME to BETA shows BETA's two minutes, not
// ACME's half hour plus BETA's two. Paused: the paused client's own time
// today, the same figure the popup's paused clock card shows. Stopped:
// today's clocked total across every client.
//
// `pausedName` is the client a paused clock would resume (clients.js's
// pausedClient), or null. Not running with a name is paused; not running
// without one is stopped, which is what the card's stop button leaves
// behind by clearing last-client.
export function panelClockState(clock, dayKey, nowMs = Date.now(), away = false, pausedName = null) {
    let running = clock.running;
    let paused = running === null && pausedName !== null;
    let seconds;
    if (running !== null)
        seconds = (nowMs - running.startMs) / 1000;
    else if (paused)
        seconds = clock.billedSecondsByClient(dayKey, nowMs).get(pausedName) ?? 0;
    else
        seconds = clock.billedSecondsForDay(dayKey, nowMs);
    return {
        running: running !== null,
        away,
        paused,
        client: running?.client ?? (paused ? pausedName : ''),
        seconds,
    };
}

// The panel label's text for a mode and a clock state; '' means hide the label.
// clock = { running, away, paused, client, seconds } as PanelIndicator.setClock
// takes it. A stopped clock shows nothing: stopping means done for now.
export function panelLabelText(mode, totalSeconds, clock) {
    if (mode === 'screen' && totalSeconds > 0)
        return formatTime(totalSeconds);
    if (mode === 'client' && clock.running)
        return `${clock.client} ${formatTime(clock.seconds)}`;
    if (mode === 'client' && clock.paused && clock.seconds > 0)
        return `${clock.client} ${formatTime(clock.seconds)}`;
    return '';
}

// Whether the panel label is faded: only a paused clock's total, so it
// reads as not counting while still there to resume.
export function panelLabelDimmed(mode, clock) {
    return mode === 'client' && clock.paused;
}
