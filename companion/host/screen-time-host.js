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
const BROWSERS = ['brave', 'zen'];
const CALL_TIMEOUT_MS = 2000;
// When the extension is disabled every call fails the same way; log it once
// a minute rather than once per tab switch.
const ERROR_LOG_INTERVAL_MS = 60000;

let stdin = new GioUnix.InputStream({ fd: 0, close_fd: false });
let stdout = new GioUnix.OutputStream({ fd: 1, close_fd: false });
let lastErrorLog = 0;

function log(msg) {
    printerr(`[screen-time-host] ${msg}`);
}

function isReport(m) {
    return m && typeof m === 'object' &&
        typeof m.browser === 'string' && BROWSERS.includes(m.browser) &&
        typeof m.host === 'string' && typeof m.detail === 'string';
}

function forward(report) {
    try {
        Gio.DBus.session.call_sync(
            BUS_NAME, OBJECT_PATH, INTERFACE, 'ReportActiveTab',
            new GLib.Variant('(sss)', [report.browser, report.host, report.detail]),
            null, Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, null);
    } catch (e) {
        let now = Date.now();
        if (now - lastErrorLog >= ERROR_LOG_INTERVAL_MS) {
            lastErrorLog = now;
            log(`ReportActiveTab failed (extension disabled?): ${e.message}`);
        }
    }
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
    forward(message);
}

let pending = new Uint8Array(0);
for (;;) {
    let chunk = stdin.read_bytes(65536, null);
    if (chunk.get_size() === 0)
        break;   // browser closed the pipe
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
}
System.exit(0);
