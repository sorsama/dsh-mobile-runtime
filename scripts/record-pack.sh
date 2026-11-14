#!/usr/bin/env bash
# Records the module pack in a finished harness tree and installs it under /opt/dsh.
# Runs as root inside the build container, on the architecture of the tree it records.
#
# Usage: record-pack.sh <rootfs> <out-dir>
# Env:   ABI, HARNESS_VERSION, NODE_VERSION (they go into the build id)
#
# It (1) fingerprints /opt/dsh, (2) runs the real harness from the tree with
# scripts/module-pack/record.mjs and makes the calls in calls.json, (3) checks the tree
# is unchanged by the run, (4) writes /opt/dsh/runtime-pack/{pack.bin,preload.mjs,replay.mjs}
# and /opt/dsh/build-id, (5) starts the harness again with the pack and checks that the pack
# switched on and answers most of what the harness asks.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
MP=$HERE/module-pack
R=$(realpath "$1"); OUT=$(realpath -m "$2")
ABI=${ABI:?set ABI}; HARNESS_VERSION=${HARNESS_VERSION:?}; NODE_VERSION=${NODE_VERSION:?}
mkdir -p "$OUT"
BIN=/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js

fp() { python3 "$MP/tree-fingerprint.py" "$R/opt/dsh" --skip runtime-pack --skip build-id 2>/dev/null; }
FP=$(fp)
BUILD_ID=$(printf 'dsh-pack-v1\n%s\n%s\n%s\n%s\n' "$FP" "$HARNESS_VERSION" "$ABI" "$NODE_VERSION" | sha256sum | cut -c1-32)
echo "tree fingerprint $FP"
echo "build id $BUILD_ID"

rm -rf "$R/opt/dsh/runtime-pack" "$R/opt/dsh/build-id"
T=$R/tmp/pack-build; rm -rf "$T"; mkdir -p "$T/tools"
cp "$MP"/record.mjs "$MP"/record-main.mjs "$MP"/drive.mjs "$MP"/calls.json "$MP"/preload.mjs "$MP"/replay.mjs "$T/tools/"

mount -t proc proc "$R/proc"; mount --rbind /dev "$R/dev"; mount -t sysfs sys "$R/sys"
cleanup() { umount -R "$R/dev" 2>/dev/null || true; umount "$R/proc" "$R/sys" 2>/dev/null || true; }
trap cleanup EXIT
in_root() { chroot "$R" /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin LANG=C.UTF-8 "$@"; }

echo "== record"
in_root /opt/node/bin/node /tmp/pack-build/tools/drive.mjs --mode record --node /opt/node/bin/node --bin "$BIN" \
  --record /tmp/pack-build/tools/record.mjs --calls /tmp/pack-build/tools/calls.json \
  --out /tmp/pack-build/out --build-id "$BUILD_ID" --work /tmp/pack-build/work
cat "$T/out/pack-summary.json"
cp "$T/out/pack-summary.json" "$OUT/pack-summary-$ABI.json"

[ "$(fp)" = "$FP" ] || { echo "FAIL: the recording run changed /opt/dsh" >&2; exit 1; }

echo "== install"
install -d -m 755 "$R/opt/dsh/runtime-pack"
install -m 644 "$T/out/pack.bin" "$MP/preload.mjs" "$MP/replay.mjs" "$R/opt/dsh/runtime-pack/"
printf '%s\n' "$BUILD_ID" > "$R/opt/dsh/build-id"; chmod 644 "$R/opt/dsh/build-id"
ls -la "$R/opt/dsh/runtime-pack"

echo "== replay check (pack on, same calls)"
rm -rf "$T/work-replay"
in_root /opt/node/bin/node /tmp/pack-build/tools/drive.mjs --mode replay --node /opt/node/bin/node --bin "$BIN" \
  --preload /opt/dsh/runtime-pack/preload.mjs --calls /tmp/pack-build/tools/calls.json --work /tmp/pack-build/work-replay \
  | tee "$T/replay.txt"
[ "$(fp)" = "$FP" ] || { echo "FAIL: the replay run changed /opt/dsh" >&2; exit 1; }
cp "$T/replay.txt" "$OUT/pack-replay-$ABI.txt"

cleanup; trap - EXIT
rm -rf "$T"
echo "pack recorded: $BUILD_ID"
echo "$BUILD_ID" > "$OUT/build-id-$ABI.txt"
