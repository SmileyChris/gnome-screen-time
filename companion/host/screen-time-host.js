#!/usr/bin/env -S gjs -m
// Native messaging host for the GNOME Screen Time browser companion.
// Reads framed JSON from the browser on stdin and forwards each active-tab
// report to the Shell extension over the session bus. Exits when stdin
// closes, which is how the browser ends a host. Writes to stdout only to
// answer {ping: true}, used by `make companion-install` as a smoke test.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
// GLib 2.80 moved the Unix stream types out of Gio; on this gjs the Gio
// aliases still work but warn on stderr, which would pollute the pipe.
import GioUnix from 'gi://GioUnix';
import System from 'system';
import { encodeFrame, decodeFrames } from './framing.js';

const BUS_NAME = 'org.gnome.Shell';
const OBJECT_PATH = '/org/gnome/Shell/Extensions/ScreenTime';
const INTERFACE = 'org.gnome.Shell.Extensions.ScreenTime';
const BROWSERS = ['brave', 'zen', 'chrome', 'firefox'];
const CALL_TIMEOUT_MS = 2000;
// When the extension is disabled every call fails the same way; log it once
// a minute rather than once per tab switch.
const ERROR_LOG_INTERVAL_MS = 60000;

let stdin = new GioUnix.InputStream({ fd: 0, close_fd: false });
let stdout = new GioUnix.OutputStream({ fd: 1, close_fd: false });
let lastErrorLog = 0;
// The most recent report, resent when the Shell extension announces itself
// (it may have started, or been reloaded, after this host connected).
let lastReport = null;

function log(msg) {
    printerr(`[screen-time-host] ${msg}`);
}

function isReport(m) {
    return m && typeof m === 'object' &&
        typeof m.browser === 'string' && BROWSERS.includes(m.browser) &&
        typeof m.host === 'string' && typeof m.detail === 'string' &&
        typeof m.focused === 'boolean';
}

function forward(report) {
    try {
        Gio.DBus.session.call_sync(
            BUS_NAME, OBJECT_PATH, INTERFACE, 'ReportActiveTab',
            new GLib.Variant('(sssb)', [report.browser, report.host, report.detail, report.focused]),
            null, Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, null);
    } catch (e) {
        let now = Date.now();
        if (now - lastErrorLog >= ERROR_LOG_INTERVAL_MS) {
            lastErrorLog = now;
            log(`ReportActiveTab failed (extension disabled?): ${e.message}`);
        }
    }
}

function onShellReady() {
    if (lastReport)
        forward(lastReport);
}

function handle(message) {
    if (message === null) {
        log('skipping malformed frame');
        return;
    }
    if (message.ping === true) {
        stdout.write_all(encodeFrame({ pong: true }), null);
        return;
    }
    if (!isReport(message)) {
        // Keys only: the values could carry whatever a rogue sender wrote.
        log(`skipping unexpected message with keys ${Object.keys(message).join(',')}`);
        return;
    }
    lastReport = message;
    forward(message);
}

// Subscribing to a signal needs no bus name of our own, so the Shell can
// reach every live host without knowing about it in advance.
Gio.DBus.session.signal_subscribe(
    BUS_NAME, INTERFACE, 'Ready', OBJECT_PATH, null,
    Gio.DBusSignalFlags.NONE, onShellReady);

// stdin is read asynchronously so the main loop stays free for the signal.
let loop = new GLib.MainLoop(null, false);
let pending = new Uint8Array(0);

function readMore() {
    stdin.read_bytes_async(65536, GLib.PRIORITY_DEFAULT, null, (stream, res) => {
        let chunk;
        try {
            chunk = stream.read_bytes_finish(res);
        } catch (e) {
            log(`stdin read failed, exiting: ${e.message}`);
            loop.quit();
            return;
        }
        if (chunk.get_size() === 0) {
            loop.quit();   // browser closed the pipe
            return;
        }
        let data = chunk.toArray();
        let joined = new Uint8Array(pending.length + data.length);
        joined.set(pending, 0);
        joined.set(data, pending.length);
        let decoded;
        try {
            decoded = decodeFrames(joined);
        } catch (e) {
            log(`protocol error, exiting: ${e.message}`);
            System.exit(1);
        }
        pending = decoded.rest;
        for (let m of decoded.messages)
            handle(m);
        readMore();
    });
}

readMore();
loop.run();
System.exit(0);
