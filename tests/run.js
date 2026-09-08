import GLib from 'gi://GLib';
import System from 'system';
import { runAll } from './harness.js';

// usageStore.js computes its file path from XDG_DATA_HOME at import time, so
// point it at a scratch directory before any test module is imported. This
// is why the test files are imported dynamically below.
let tmp = GLib.Dir.make_tmp('screen-time-test-XXXXXX');
GLib.setenv('XDG_DATA_HOME', tmp, true);

const FILES = [
    './zellijLayout.test.js',
    './usageStore.test.js',
];

let loop = new GLib.MainLoop(null, false);
let failed = 1;
(async () => {
    for (let f of FILES)
        await import(f);
    failed = await runAll();
})().catch(e => {
    printerr(e.stack ?? String(e));
}).finally(() => loop.quit());
loop.run();
System.exit(failed ? 1 : 0);
