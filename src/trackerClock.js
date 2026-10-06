// The tracker's clock arithmetic, kept free of Shell imports so it can be
// tested under plain gjs.

// Works out how many whole seconds to credit for the stretch since lastTime,
// and where the clock should restart. The store keeps whole seconds, so the
// fraction rounded away is left on the clock instead of being dropped: short
// flushes (quick focus changes) then neither lose time nor inflate it.
export function advanceClock(lastTime, now, maxSecs) {
    let elapsed = (now - lastTime) / 1000;
    let secs = Math.min(elapsed, maxSecs);
    if (secs <= 0) {
        // In debt from a previous round-up: leave the clock so the debt is
        // repaid by the next flush. A whole negative second cannot come from
        // rounding, so that is a clock jump: resynchronise.
        return { credited: 0, lastTime: secs <= -1 ? now : lastTime };
    }
    let credited = Math.round(secs);
    // Advancing by exactly what was credited leaves the residual (or the
    // debt) between the clock and now, in whole milliseconds. When maxSecs
    // capped the stretch, the excess is discarded on purpose (that is what
    // the setting is for), so no residual.
    return {
        credited,
        lastTime: secs < elapsed ? now : lastTime + credited * 1000,
    };
}
