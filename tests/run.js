import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import { runAll } from './harness.js';
import { installURLShim } from './urlShim.js';

// companion/webext/rules.js is written against the browser's `URL` global,
// which gjs does not provide. Install a GLib.Uri-backed stand-in before the
// test modules load.
installURLShim();

// usageStore.js computes its file path from XDG_DATA_HOME at import time, so
// point it at a scratch directory before any test module is imported. This
// is why the test files are imported dynamically below.
let tmp = GLib.Dir.make_tmp('screen-time-test-XXXXXX');
GLib.setenv('XDG_DATA_HOME', tmp, true);

const FILES = [
    './zellijLayout.test.js',
    './usageStore.test.js',
    './activitySources.test.js',
    './rules.test.js',
    './framing.test.js',
];

// Deletes the usage.json (and its parent dirs) that UsageStore wrote under
// `tmp` during the run, so the scratch directory doesn't accumulate on disk
// across runs.
function deleteRecursive(path) {
    let file = Gio.File.new_for_path(path);
    let enumerator = file.enumerate_children(
        'standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    let info;
    while ((info = enumerator.next_file(null)) !== null) {
        let child = file.get_child(info.get_name());
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            deleteRecursive(child.get_path());
        else
            child.delete(null);
    }
    enumerator.close(null);
    file.delete(null);
}

// A desktop session's gvfs metadata daemon can notice a freshly used
// XDG_DATA_HOME and drop a `gvfs-metadata` directory into it moments after
// the run, racing this cleanup. Retry a few times with a short backoff
// rather than leaking the scratch directory over one lost race.
function cleanupTmp(path, attemptsLeft = 6) {
    try {
        deleteRecursive(path);
    } catch (e) {
        if (attemptsLeft <= 1) {
            console.debug(`[ScreenTime tests] could not remove ${path}: ${e.message}`);
            return;
        }
        GLib.usleep(50000);
        cleanupTmp(path, attemptsLeft - 1);
    }
}

let loop = new GLib.MainLoop(null, false);
let failed = 1;
(async () => {
    for (let f of FILES)
        await import(f);
    failed = await runAll();
    cleanupTmp(tmp);
})().catch(e => {
    printerr(e.stack || String(e));
}).finally(() => loop.quit());
loop.run();
System.exit(failed ? 1 : 0);
