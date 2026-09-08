#!/usr/bin/env python3
"""Build and install helpers for the browser companion.

    build.py build          -> dist/webext-brave/, dist/screen-time-brave.zip,
                               dist/screen-time-zen.xpi
    build.py extension-id   -> Chromium extension id derived from manifest key
    build.py ping           -> framed {ping:true} to the host, expects {pong:true}
"""
import base64
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
# An allowlist, never a directory listing: chromium-key.pem lives in the same
# directory as these sources and must never be copied into a build.
SOURCES = ['background.js', 'rules.js']


def load_manifest():
    with open(os.path.join(WEBEXT, 'manifest.json')) as f:
        return json.load(f)


def extension_id(manifest):
    # Chromium: SHA-256 of the DER public key, first 32 hex chars, 0-9a-f -> a-p.
    der = base64.b64decode(manifest['key'])
    digest = hashlib.sha256(der).hexdigest()[:32]
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

    with open(os.path.join(WEBEXT, 'manifest.gecko.json')) as f:
        overlay = json.load(f)
    gecko = dict(base)
    gecko.pop('key', None)   # Gecko rejects unknown top-level keys with a warning
    gecko.update(overlay)
    zen_tree = write_tree('zen', gecko)
    zip_tree(zen_tree, os.path.join(DIST, 'screen-time-zen.xpi'))

    print(f'built {brave_tree} (id {extension_id(base)}) and {zen_tree}')


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
        print(extension_id(load_manifest()))
    elif cmd == 'ping':
        ping()
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
