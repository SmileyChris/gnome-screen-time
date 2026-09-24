// Names for windows the Shell has no .desktop file for, from their WM_CLASS
// (on Wayland, the app id). A reverse-DNS class such as
// org.gnome.Shell.Extensions.ScreenTime.Timesheet would otherwise show raw:
// the leading lowercase domain segments are dropped, the second-last of the
// rest becomes the app and the last its child activity, so it reads as
// "Screen Time" with "Timesheet" beneath it. No imports, so plain gjs tests
// cover it.

const REVERSE_DNS = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+$/;

// "ScreenTime" -> "Screen Time"; runs of capitals ("IDE") stay together.
function words(segment) {
    return segment
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

// { appClass, appName, child: { id, name } | null } for a reverse-DNS class,
// or null for anything else (a plain "Firefox" or "jetbrains-idea" keeps
// the Shell's own name). `appClass` is the class up to the app segment, so
// every window of the same app family shares one parent.
export function splitWindowClass(wmClass) {
    if (!wmClass || !REVERSE_DNS.test(wmClass))
        return null;
    let segments = wmClass.split('.');
    let first = segments.findIndex(s => s !== s.toLowerCase());
    let rest = first === -1 ? segments.slice(-1) : segments.slice(first);
    if (rest.length < 2)
        return { appClass: wmClass, appName: words(rest[0]), child: null };
    let child = rest[rest.length - 1];
    return {
        appClass: segments.slice(0, -1).join('.'),
        appName: words(rest[rest.length - 2]),
        child: { id: child, name: words(child) },
    };
}
