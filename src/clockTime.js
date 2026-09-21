import GLib from 'gi://GLib';

// "HH:MM" -> epoch ms, resolved to whichever calendar day around
// `referenceMs` puts that wall-clock time closest to it - not pinned to
// referenceMs's own day. Returns null if the text is not a time, so the
// caller can say so rather than writing a NaN.
//
// A field always seeds from, and is compared against, its own current
// value (the session's startMs for Started, its endMs for Ended - see
// timesheetWindow.js's _timeRow), so `referenceMs` is normally only
// fractions of an hour away from what the user actually meant. Pinning the
// parse to referenceMs's own calendar day breaks exactly the case the
// owner hits most: a session showing Started 00:10 on the 11th that really
// began at 23:50 on the 10th. Typed as "23:50" and resolved onto the 11th
// (the display's own day), that lands nearly a full day *after* the
// reference - `update()` then sees a start after the end and rejects it as
// 'backwards', which describes the wrong problem entirely. Building all
// three candidates (the day before, the same day, and the day after
// referenceMs's calendar day) and picking whichever is nearest to
// referenceMs handles this in both directions: 00:10 -> "23:50" picks the
// day before (20 minutes away, not 23h40m); an Ended of 23:00 -> "01:30"
// picks the day after (2h30m away, not 21h30m). On an exact tie (a
// wall-clock time exactly 12h from referenceMs either way) the earlier of
// the two candidates wins, which is also just a side effect of trying the
// day-before candidate first and requiring a strictly smaller distance to
// replace it.
//
// Two DST quirks follow from building candidates with GLib.DateTime.new_local
// (which resolves in the machine's local zone) rather than doing arithmetic
// in UTC:
//   - A time inside a spring-forward gap (does not exist locally - NZ had
//     02:00-02:59 vanish on 2026-09-27) is not rejected: GLib silently
//     clamps it forward to the zone's new start time (02:30 becomes 03:00),
//     so the candidate for that day is off by however far into the gap the
//     typed time was.
//   - A time inside a fall-back overlap (occurs twice - NZ repeated
//     02:00-02:59 on 2026-04-05) resolves to the LATER of the two real
//     instants (standard time, once daylight time has ended), not
//     necessarily the one the user was picturing.
// Both are GLib.DateTime.new_local's behaviour, not something this function
// corrects for; see clockTime.test.js for a machine-independent pin of the
// gap/overlap clamping itself (via an explicit Pacific/Auckland
// GLib.TimeZone rather than the test machine's own zone).
export function parseClock(text, referenceMs) {
    let match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
    if (!match)
        return null;
    let [, h, m] = match;
    let hour = Number(h);
    let minute = Number(m);
    if (hour > 23 || minute > 59)
        return null;

    let ref = GLib.DateTime.new_from_unix_local(referenceMs / 1000);
    let bestMs = null;
    let bestDistance = Infinity;
    // -1, 0, 1 in chronological order, so a tie (equal distance on both
    // sides) is resolved to the earlier candidate: it is tried first and a
    // later, merely-equal candidate never beats a strictly smaller
    // distance.
    for (let dayOffset of [-1, 0, 1]) {
        let day = ref.add_days(dayOffset);
        let candidate = GLib.DateTime.new_local(
            day.get_year(), day.get_month(), day.get_day_of_month(),
            hour, minute, 0);
        let candidateMs = candidate.to_unix() * 1000;
        let distance = Math.abs(candidateMs - referenceMs);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestMs = candidateMs;
        }
    }
    return bestMs;
}
