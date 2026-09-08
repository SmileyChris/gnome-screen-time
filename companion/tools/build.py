#!/usr/bin/env python3
"""Build and install helpers for the browser companion.

    build.py build          -> dist/webext-brave/, dist/webext-chrome/, their zips,
                               dist/webext-zen/, dist/webext-firefox/, their xpis
    build.py extension-id [browser]
                            -> Chromium extension id for that unpacked build
    build.py ping           -> framed {ping:true} to the host, expects {pong:true}
"""
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEBEXT = os.path.join(ROOT, 'companion', 'webext')
HOST = os.path.join(ROOT, 'companion', 'host', 'screen-time-host.js')
DIST = os.path.join(ROOT, 'dist')
# An allowlist, never a directory listing, so a stray file in this directory
# never reaches a build.
SOURCES = ['background.js', 'rules.js']


def load_manifest():
    with open(os.path.join(WEBEXT, 'manifest.json')) as f:
        return json.load(f)


def extension_id(browser):
    # An unpacked Chromium extension has no signing key, so its id comes from the
    # absolute directory path: SHA-256 of the path, first 32 hex chars, 0-9a-f ->
    # a-p. Chromium resolves symlinks first, so realpath here too. Nothing in the
    # source names a publisher; a store-published build gets its key from the
    # store. Each browser loads its own tree, so each has its own id.
    path = os.path.realpath(os.path.join(DIST, f'webext-{browser}'))
    digest = hashlib.sha256(path.encode()).hexdigest()[:32]
    return ''.join(chr(ord('a') + int(c, 16)) for c in digest)


def write_tree(browser, manifest):
    out = os.path.join(DIST, f'webext-{browser}')
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)
    for name in SOURCES:
        shutil.copy(os.path.join(WEBEXT, name), out)
    with open(os.path.join(out, 'browser-id.js'), 'w') as f:
        f.write(f"export const BROWSER = '{browser}';\n")
    with open(os.path.join(out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=4)
        f.write('\n')
    return out


def zip_tree(tree, target):
    if os.path.exists(target):
        os.remove(target)
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(tree)):
            z.write(os.path.join(tree, name), name)


def build():
    os.makedirs(DIST, exist_ok=True)
    base = load_manifest()

    brave_tree = write_tree('brave', base)
    zip_tree(brave_tree, os.path.join(DIST, 'screen-time-brave.zip'))
    # The same Chromium build, a different browser constant and its own id.
    chrome_tree = write_tree('chrome', base)
    zip_tree(chrome_tree, os.path.join(DIST, 'screen-time-chrome.zip'))

    with open(os.path.join(WEBEXT, 'manifest.gecko.json')) as f:
        overlay = json.load(f)
    gecko = dict(base)
    gecko.update(overlay)
    zen_tree = write_tree('zen', gecko)
    zip_tree(zen_tree, os.path.join(DIST, 'screen-time-zen.xpi'))
    # Firefox: the same Gecko build and host manifest, a different browser constant.
    firefox_tree = write_tree('firefox', gecko)
    zip_tree(firefox_tree, os.path.join(DIST, 'screen-time-firefox.xpi'))

    print(f'built {brave_tree} (id {extension_id("brave")}), '
          f'{chrome_tree} (id {extension_id("chrome")}), {zen_tree} and {firefox_tree}')


def ping():
    body = json.dumps({'ping': True}).encode()
    proc = subprocess.run(['gjs', '-m', HOST], input=struct.pack('<I', len(body)) + body,
                          capture_output=True, timeout=10)
    out = proc.stdout
    if len(out) < 4:
        sys.exit(f'host produced no frame; stderr: {proc.stderr.decode(errors="replace")}')
    n = struct.unpack('<I', out[:4])[0]
    reply = json.loads(out[4:4 + n])
    if reply != {'pong': True}:
        sys.exit(f'unexpected reply {reply!r}')
    print('pong')


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'build'
    if cmd == 'build':
        build()
    elif cmd == 'extension-id':
        print(extension_id(sys.argv[2] if len(sys.argv) > 2 else 'brave'))
    elif cmd == 'ping':
        ping()
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
