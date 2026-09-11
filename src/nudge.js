// Pure timing rule for the idle nudge, kept out of extension.js so it can be
// unit tested without the Shell. Never import Shell/St/Clutter/Main here.

// Once nudged, wait this long before nudging again for the same idle spell -
// the notification is updated in place rather than stacked, so this is what
// keeps it from re-popping every 30-second heartbeat tick.
export const NUDGE_REPEAT_MS = 3600 * 1000;

// True once `awaySinceMs` (0 means not away) has lasted at least
// `thresholdMinutes`, and either no nudge has fired yet for this spell
// (`lastNudgeMs` 0) or the last one was over an hour ago. A threshold of 0
// disables the nudge entirely.
export function nudgeDue(awaySinceMs, lastNudgeMs, nowMs, thresholdMinutes) {
    if (thresholdMinutes <= 0 || !awaySinceMs)
        return false;
    if (nowMs - awaySinceMs < thresholdMinutes * 60 * 1000)
        return false;
    if (lastNudgeMs > 0 && nowMs - lastNudgeMs < NUDGE_REPEAT_MS)
        return false;
    return true;
}
