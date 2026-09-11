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
// ACME's half hour plus BETA's two. Stopped: today's billed total across
// every client, the "what there is to bill" summary the running branch is
// deliberately not.
export function panelClockState(clock, dayKey, nowMs = Date.now(), away = false) {
    let running = clock.running;
    return {
        running: running !== null,
        away,
        client: running?.client ?? '',
        seconds: running !== null
            ? (nowMs - running.startMs) / 1000
            : clock.billedSecondsForDay(dayKey, nowMs),
    };
}

// The panel label's text for a mode and a clock state; '' means hide the label.
// clock = { running, away, client, seconds } as PanelIndicator.setClock takes it.
export function panelLabelText(mode, totalSeconds, clock) {
    if (mode === 'screen' && totalSeconds > 0)
        return formatTime(totalSeconds);
    if (mode === 'client' && clock.running)
        return `${clock.client} ${formatTime(clock.seconds)}`;
    if (mode === 'client' && clock.seconds > 0)
        return formatTime(clock.seconds);
    return '';
}
