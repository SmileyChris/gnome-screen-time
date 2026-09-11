// What was on screen during one clock session.
//
// `unattributedSeconds` is the span minus what the interval log accounts for.
// It is not called idle on purpose: the tracker credits nothing while away,
// but it also credits nothing when no window has focus at all (the desktop,
// the overview), and both land here.
//
// It also undercounts a walk-away: time before the idle watch fires is
// credited to the last focused app, so up to one idle-timeout per spell looks
// like activity. Say so in the UI rather than trying to correct it.
export function evidenceFor(session, intervalLog, nowMs = Date.now()) {
    let end = session.endMs ?? nowMs;
    let spanSeconds = Math.max(0, Math.round((end - session.startMs) / 1000));
    let { seconds, entries } = intervalLog.query(session.startMs, end);
    return {
        spanSeconds,
        // `seconds` is IntervalLog.query()'s bottom-up-rounded total, taken
        // as-is: each node in that tree rounds independently, so this can
        // overshoot the true tracked time by up to ~0.5s per node. Recomputing
        // or re-rounding it here would just disagree with `entries`.
        trackedSeconds: seconds,
        unattributedSeconds: Math.max(0, spanSeconds - seconds),
        entries,
    };
}
