// The Timesheet's command line, shared by the Shell side that launches it
// (extension.js) and the Timesheet itself (timesheet.js), so the two cannot
// drift apart. No imports, so plain gjs tests cover it.

const DAY_PREFIX = '--day=';

export function dayArg(dayKey) {
    return `${DAY_PREFIX}${dayKey}`;
}

// The dayKey a --day=YYYY-MM-DD argument names, or null when there is none
// or it is not a real date.
export function dayFromArgs(args) {
    let arg = args.find(a => a.startsWith(DAY_PREFIX));
    if (!arg)
        return null;
    let day = arg.slice(DAY_PREFIX.length);
    let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    if (!match)
        return null;
    let [year, month, date] = match.slice(1).map(Number);
    // Date.UTC rolls an impossible date over (Feb 30 into March), so a
    // mismatch on the way back out means it was never a real day.
    let parsed = new Date(Date.UTC(year, month - 1, date));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== date)
        return null;
    return day;
}
