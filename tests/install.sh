#!/usr/bin/env bash
# Regression test for `make install`: it must replace the installed extension
# directory by rename, never by overwriting files in it in place. An in-place
# overwrite of schemas/gschemas.compiled changed the bytes under a running
# Shell's mmap of that file and aborted the user's session on 2026-09-11 (see
# .superpowers/sdd/2026-09-11-project-time-tracking/task-6a-brief.md). This
# test reproduces the exact mechanism: it holds a real memory map of an
# installed schema file open across a second `make install` and checks that
# the mapping keeps reading the old, consistent bytes.
#
# Everything happens inside a throwaway scratch directory. EXTENSION_DIR,
# SRC_DIR and DEV_UUID_FILE are always passed explicitly on the `make`
# command line so this test can never touch the real, live installation.
set -euo pipefail

UUID='screen-time@gnome-screen-time'

# --- Safety guard: must exist before any `make` invocation below. ---------
# This test is only safe because every EXTENSION_DIR it uses lives under a
# mktemp -d scratch root. Verify that structurally, not just by construction,
# before doing anything else.
abort_if_live() {
    local resolved live
    resolved=$(realpath -m -- "$1")
    live=$(realpath -m -- "$HOME/.local/share/gnome-shell")
    case "$resolved" in
        "$live" | "$live"/*)
            echo "install.sh: refusing to run - EXTENSION_DIR ($resolved) resolves under the live GNOME Shell extensions tree ($live)" >&2
            exit 1
            ;;
    esac
}

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

ROOT=$(mktemp -d)
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

EXT_DIR="$ROOT/gnome-shell/extensions/$UUID"
DEV_UUID_FILE="$ROOT/no-dev-uuid"
SRC_A="$ROOT/srcA"
SRC_B="$ROOT/srcB"

# Guard checked against the actual path this run will use, before the first
# `make` call is even assembled below.
abort_if_live "$EXT_DIR"

# --- Build two source trees that compile to genuinely different schemas. --
cp -r "$REPO_ROOT/src" "$SRC_A"
cp -r "$REPO_ROOT/src" "$SRC_B"

python3 - "$SRC_B/schemas/org.gnome.shell.extensions.screen-time.gschema.xml" <<'PY'
import sys

path = sys.argv[1]
with open(path) as f:
    xml = f.read()

marker = '    <key name="install-test-marker" type="i"><default>0</default></key>\n'
needle = '</schema>'
if needle not in xml:
    sys.exit(f"install.sh: no </schema> to insert marker key before in {path}")
xml = xml.replace(needle, marker + needle, 1)

with open(path, 'w') as f:
    f.write(xml)
PY

if diff -q \
    "$SRC_A/schemas/org.gnome.shell.extensions.screen-time.gschema.xml" \
    "$SRC_B/schemas/org.gnome.shell.extensions.screen-time.gschema.xml" >/dev/null; then
    echo "install.sh: FAIL - srcA and srcB schemas are identical; test setup is broken" >&2
    exit 1
fi

run_make_install() {
    local src_dir="$1"
    make -C "$REPO_ROOT" --no-print-directory install \
        EXTENSION_DIR="$EXT_DIR" SRC_DIR="$src_dir" DEV_UUID_FILE="$DEV_UUID_FILE"
}

# --- Install A, then record the inode of its compiled schema. -------------
run_make_install "$SRC_A" >/dev/null

SCHEMA_FILE="$EXT_DIR/schemas/gschemas.compiled"
if [ ! -f "$SCHEMA_FILE" ]; then
    echo "install.sh: FAIL - $SCHEMA_FILE missing after installing A" >&2
    exit 1
fi

INODE_BEFORE=$(stat -c %i "$SCHEMA_FILE")

# --- Hold a real mmap of A's installed schema open across installing B. ---
# A small Python helper: it opens and maps the file, runs the second
# `make install` as a subprocess while the mapping is alive, then compares
# the mapped bytes to what it read before installing B. If an in-place
# overwrite corrupts or shrinks the file under the mapping, the read below
# can itself raise (or, in the worst case, deliver SIGBUS and kill this
# helper outright) - both are failures of assertion (a), handled below.
set +e
PY_OUTPUT=$(python3 - "$SCHEMA_FILE" "$REPO_ROOT" "$EXT_DIR" "$SRC_B" "$DEV_UUID_FILE" <<'PY'
import mmap
import os
import subprocess
import sys

schema_file, repo_root, ext_dir, src_b, dev_uuid_file = sys.argv[1:6]

fd = os.open(schema_file, os.O_RDONLY)
try:
    before = os.read(fd, os.fstat(fd).st_size)
    os.lseek(fd, 0, os.SEEK_SET)
    mm = mmap.mmap(fd, 0, prot=mmap.PROT_READ)
except OSError as exc:
    print(f"FAIL:setup:{exc}")
    sys.exit(1)

try:
    result = subprocess.run(
        ["make", "-C", repo_root, "--no-print-directory", "install",
         f"EXTENSION_DIR={ext_dir}", f"SRC_DIR={src_b}",
         f"DEV_UUID_FILE={dev_uuid_file}"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
except OSError as exc:
    print(f"FAIL:install-b-exec:{exc}")
    sys.exit(1)

if result.returncode != 0:
    out = result.stdout.decode(errors="replace")
    print(f"FAIL:install-b-failed:rc={result.returncode}:{out}")
    sys.exit(1)

try:
    mapped = mm[:]
except (OSError, ValueError) as exc:
    # A truncate-then-rewrite in place can leave the mapping pointing past
    # the (transiently shorter) file; reading it then raises rather than
    # crashing the process outright.
    print(f"FAIL:mmap-read-raised:{exc}")
    sys.exit(1)

if mapped != before:
    print("FAIL:mapping-changed")
    sys.exit(1)

print("PASS:mapping-intact")
PY
)
PY_STATUS=$?
set -e

if [ "$PY_STATUS" -ne 0 ]; then
    if [ "$PY_STATUS" -ge 128 ]; then
        sig=$((PY_STATUS - 128))
        echo "install: FAIL - (a) mapping did not survive: the mmap helper died from signal $sig (likely SIGBUS from an in-place overwrite truncating the mapped file) while installing B" >&2
    else
        echo "install: FAIL - (a) mapping did not survive: $PY_OUTPUT" >&2
    fi
    exit 1
fi

case "$PY_OUTPUT" in
    PASS:mapping-intact) ;;
    FAIL:mapping-changed)
        echo "install: FAIL - (a) mapping of A's file no longer reads A's bytes after installing B" >&2
        exit 1
        ;;
    *)
        echo "install: FAIL - (a) mmap check errored: $PY_OUTPUT" >&2
        exit 1
        ;;
esac

# --- (b) the installed file now has a different inode. --------------------
INODE_AFTER=$(stat -c %i "$SCHEMA_FILE")
if [ "$INODE_AFTER" = "$INODE_BEFORE" ]; then
    echo "install: FAIL - (b) inode did not change after installing B (still $INODE_BEFORE)" >&2
    exit 1
fi

# --- (c) the installed file's content is B's compiled schema. -------------
if ! cmp -s "$SCHEMA_FILE" "$SRC_B/schemas/gschemas.compiled"; then
    echo "install: FAIL - (c) installed schema content does not match B's compiled schema" >&2
    exit 1
fi

# --- (d) neither the staging nor the .old directory is left behind. -------
EXT_PARENT_PARENT=$(dirname "$(dirname "$EXT_DIR")")
STAGE_DIR="$EXT_PARENT_PARENT/.$UUID.staging"
OLD_DIR="$EXT_PARENT_PARENT/.$UUID.old"
if [ -e "$STAGE_DIR" ] || [ -e "$OLD_DIR" ]; then
    echo "install: FAIL - (d) leftover directory after install (staging: $STAGE_DIR, old: $OLD_DIR)" >&2
    exit 1
fi

echo "install: ok"
