#!/usr/bin/env bash
# Builds the base and harness layers for one architecture. Runs as root inside a
# privileged debian:trixie container on a runner of the same architecture.
#
# Usage: build-layers.sh <abi: arm64-v8a|x86_64> <out-dir>
# Env:   HARNESS_VERSION (exact npm version), RELEASE_ID
#        NODE_VERSION / DEBIAN_SNAPSHOT override the pins in versions.env when set.
#
# Output (in <out-dir>):
#   dsh-runtime-base-<abi>.tar.zst, dsh-runtime-harness-<abi>.tar.zst
#   layers-<abi>.json  (versions, sizes, hashes, prune and alignment results)
#   prune-<abi>.json, alignment-<abi>.json
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ABI=$1
OUT=$(realpath -m "$2")
_node_override=${NODE_VERSION:-}
_snapshot_override=${DEBIAN_SNAPSHOT:-}
# shellcheck source=versions.env
. "$HERE/versions.env"
NODE_VERSION=${_node_override:-$NODE_VERSION}
DEBIAN_SNAPSHOT=${_snapshot_override:-$DEBIAN_SNAPSHOT}
HARNESS_VERSION=${HARNESS_VERSION:?set HARNESS_VERSION}
RELEASE_ID=${RELEASE_ID:?set RELEASE_ID}

case $ABI in
  arm64-v8a) DEBARCH=arm64; NODEARCH=arm64; MACHINE=aarch64; STRICT=--strict ;;
  x86_64) DEBARCH=amd64; NODEARCH=x64; MACHINE=x86_64; STRICT= ;;
  *) echo "unknown abi $ABI" >&2; exit 1 ;;
esac
[ "$(dpkg --print-architecture)" = "$DEBARCH" ] || { echo "run this on a $DEBARCH host" >&2; exit 1; }

# Reproducible timestamps: everything gets the snapshot time.
SOURCE_DATE_EPOCH=$(date -u -d "$(echo "$DEBIAN_SNAPSHOT" | sed -E 's/^(....)(..)(..)T(..)(..)(..)Z$/\1-\2-\3 \4:\5:\6/')" +%s)
export SOURCE_DATE_EPOCH
BASE_ID="$DEBIAN_SUITE-$DEBIAN_SNAPSHOT-node$NODE_VERSION-r$BASE_REVISION"
WORK=/work/$ABI
R=$WORK/rootfs
rm -rf "$WORK"; mkdir -p "$WORK" "$OUT"
T0=$(date +%s)
log() { echo "== [$(( $(date +%s) - T0 ))s] $*"; }

log "tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends mmdebstrap ca-certificates curl xz-utils zstd \
  python3 binutils gpgv tar >/dev/null

########################################################################
log "debian $DEBIAN_SUITE ($DEBARCH) from snapshot $DEBIAN_SNAPSHOT"
SNAP=https://snapshot.debian.org/archive
mmdebstrap --mode=root --variant=minbase --arch="$DEBARCH" --format=directory \
  --include="$DEBIAN_PACKAGES" \
  --aptopt='Acquire::Check-Valid-Until "false"' \
  --aptopt='Acquire::Retries "8"' \
  --aptopt='Acquire::http::Timeout "120"' \
  --aptopt='Acquire::https::Timeout "120"' \
  --dpkgopt='path-exclude=/usr/share/man/*' \
  --dpkgopt='path-exclude=/usr/share/info/*' \
  --dpkgopt='path-exclude=/usr/share/lintian/*' \
  --dpkgopt='path-exclude=/usr/share/locale/*' \
  --dpkgopt='path-include=/usr/share/locale/locale.alias' \
  --dpkgopt='path-exclude=/usr/share/doc/*' \
  --dpkgopt='path-include=/usr/share/doc/*/copyright' \
  "$DEBIAN_SUITE" "$R" \
  "deb [check-valid-until=no] $SNAP/debian/$DEBIAN_SNAPSHOT $DEBIAN_SUITE main" \
  "deb [check-valid-until=no] $SNAP/debian/$DEBIAN_SNAPSHOT $DEBIAN_SUITE-updates main" \
  "deb [check-valid-until=no] $SNAP/debian-security/$DEBIAN_SNAPSHOT $DEBIAN_SUITE-security main"
chroot "$R" dpkg-query -W -f='${Package} ${Version}\n' > "$OUT/debian-packages-$ABI.txt"
log "$(wc -l < "$OUT/debian-packages-$ABI.txt") Debian packages, $(du -sh "$R" | cut -f1)"

########################################################################
log "node $NODE_VERSION ($NODEARCH)"
ND=$WORK/node; mkdir -p "$ND"
NODE_TXZ=node-v$NODE_VERSION-linux-$NODEARCH.tar.xz
curl -fsSL --retry 5 --retry-all-errors -o "$ND/$NODE_TXZ" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TXZ"
curl -fsSL --retry 5 --retry-all-errors -o "$ND/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
curl -fsSL --retry 5 --retry-all-errors -o "$ND/SHASUMS256.txt.sig" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt.sig"
curl -fsSL --retry 5 --retry-all-errors -o "$ND/pubring.kbx" \
  "https://github.com/nodejs/release-keys/raw/HEAD/gpg-only-active-keys/pubring.kbx"
gpgv --keyring "$ND/pubring.kbx" "$ND/SHASUMS256.txt.sig" "$ND/SHASUMS256.txt"
(cd "$ND" && grep " $NODE_TXZ\$" SHASUMS256.txt | sha256sum -c -)
mkdir -p "$R/opt/node"
tar -xJf "$ND/$NODE_TXZ" -C "$R/opt/node" --strip-components=1 --no-same-owner
rm -rf "$R/opt/node/include" "$R/opt/node/share" "$R/opt/node/CHANGELOG.md" "$R/opt/node/README.md"
for b in node npm npx corepack; do ln -sfn "/opt/node/bin/$b" "$R/usr/local/bin/$b"; done
chroot "$R" /opt/node/bin/node -e 'console.log("node", process.version, process.arch)'

########################################################################
log "rootfs fixes"
# Android has no /etc/resolv.conf. This placeholder works on most networks; the app
# should rewrite it at every start from the active network's DNS servers.
rm -f "$R/etc/resolv.conf"
printf '# Placeholder. DSH Mobile rewrites this file with the device DNS servers at start.\nnameserver 8.8.8.8\nnameserver 1.1.1.1\n' > "$R/etc/resolv.conf"
printf '127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n' > "$R/etc/hosts"
echo localhost > "$R/etc/hostname"
mkdir -p "$R/tmp" "$R/root/work"; chmod 1777 "$R/tmp"; chmod 700 "$R/root"
# Fake /proc files: SELinux denies apps /proc/stat, /proc/loadavg and /proc/uptime,
# which leaves os.cpus() empty. The app binds these over the real ones and may
# rewrite them first (for example /proc/stat with the device's CPU count).
P=$R/opt/dsh-runtime/proc; mkdir -p "$P"
{
  echo "cpu  4000 0 2000 64000 100 0 50 0 0 0"
  for i in 0 1 2 3 4 5 6 7; do echo "cpu$i 500 0 250 8000 12 0 6 0 0 0"; done
  echo "intr 0"; echo "ctxt 0"; echo "btime $SOURCE_DATE_EPOCH"; echo "processes 1"
  echo "procs_running 1"; echo "procs_blocked 0"; echo "softirq 0 0 0 0 0 0 0 0 0 0 0"
} > "$P/stat"
echo "0.12 0.10 0.05 1/128 1" > "$P/loadavg"
echo "1000.00 7000.00" > "$P/uptime"
# Apt points at the live mirrors so `apt-get update && apt-get install` works for users.
rm -f "$R/etc/apt/sources.list"
cat > "$R/etc/apt/sources.list.d/debian.sources" <<EOF
Types: deb
URIs: http://deb.debian.org/debian
Suites: $DEBIAN_SUITE $DEBIAN_SUITE-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: http://deb.debian.org/debian-security
Suites: $DEBIAN_SUITE-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
# Not reproducible and not useful on a phone.
rm -rf "$R"/var/lib/apt/lists/* "$R"/var/cache/apt/* "$R"/var/cache/debconf/*-old \
       "$R"/var/cache/ldconfig/aux-cache "$R"/var/log/* "$R"/tmp/* "$R"/run/* \
       "$R"/dev/* "$R"/proc/* "$R"/sys/*
: > "$R/etc/machine-id"
cat > "$R/opt/dsh-runtime/base.json" <<EOF
{"baseId": "$BASE_ID", "abi": "$ABI", "debianSuite": "$DEBIAN_SUITE", "debianSnapshot": "$DEBIAN_SNAPSHOT", "nodeVersion": "$NODE_VERSION"}
EOF

########################################################################
pack() { # name, paths... ; reads EXCLUDES
  local name=$1; shift
  local tarf=$WORK/$name.tar
  (cd "$R" && tar --create --file="$tarf" --format=gnu --sort=name --mtime="@$SOURCE_DATE_EPOCH" \
     --owner=0 --group=0 --numeric-owner --hard-dereference --no-acls --no-xattrs --no-selinux \
     --anchored "${EXCLUDES[@]}" -- "$@")
  python3 "$HERE/tar-stats.py" "$tarf" > "$WORK/$name.stats.json"
  zstd -q -19 --long=27 -T0 -f -o "$OUT/$name.tar.zst" "$tarf"
  rm -f "$tarf"
  log "$name: $(stat -c %s "$OUT/$name.tar.zst") bytes compressed, $(cat "$WORK/$name.stats.json")"
}

log "pack base layer"
mapfile -t TOP < <(cd "$R" && ls -A | LC_ALL=C sort)
EXCLUDES=(--exclude=opt/dsh --exclude=usr/local/bin/dsh)
pack "dsh-runtime-base-$ABI" "${TOP[@]}"
python3 "$HERE/tree-snapshot.py" save "$R" "$WORK/before.json"

########################################################################
log "harness @deepseek-ai/dsh@$HARNESS_VERSION"
cp -a "$R/etc/resolv.conf" "$WORK/resolv.conf.saved"
cp /etc/resolv.conf "$R/etc/resolv.conf"
mount -t proc proc "$R/proc"; mount --rbind /dev "$R/dev"; mount -t sysfs sys "$R/sys"
cleanup_mounts() { umount -R "$R/dev" 2>/dev/null || true; umount "$R/proc" "$R/sys" 2>/dev/null || true; }
trap cleanup_mounts EXIT
chroot "$R" /usr/bin/env -i HOME=/root USER=root LANG=C.UTF-8 TERM=dumb TMPDIR=/tmp \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
  npm_config_cache=/tmp/npm-cache npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
  /bin/bash -euc "mkdir -p /opt/dsh && cd /opt/dsh && npm install --omit=dev --foreground-scripts --loglevel=warn '@deepseek-ai/dsh@$HARNESS_VERSION'"
INSTALLED=$(chroot "$R" /opt/node/bin/node -p 'require("/opt/dsh/node_modules/@deepseek-ai/dsh/package.json").version')
[ "$INSTALLED" = "$HARNESS_VERSION" ] || { echo "installed $INSTALLED, wanted $HARNESS_VERSION" >&2; exit 1; }
cleanup_mounts; trap - EXIT
cp -a "$WORK/resolv.conf.saved" "$R/etc/resolv.conf"
rm -rf "$R"/tmp/* "$R"/tmp/.[!.]* "$R/root/.npm" "$R/root/.cache" "$R/root/.config"

cat > "$R/usr/local/bin/dsh" <<'EOF'
#!/bin/sh
# DeepSeek Harness launcher (DSH Mobile runtime). exec keeps the PID, so the app
# can stop the harness by signalling the guest's main process.
exec /opt/node/bin/node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
EOF
chmod 755 "$R/usr/local/bin/dsh"
cat > "$R/opt/dsh/layer.json" <<EOF
{"harnessPackage": "@deepseek-ai/dsh", "harnessVersion": "$HARNESS_VERSION", "releaseId": "$RELEASE_ID", "abi": "$ABI", "baseId": "$BASE_ID"}
EOF
python3 "$HERE/tree-snapshot.py" save "$R" "$WORK/after.json"
python3 "$HERE/tree-snapshot.py" compare "$WORK/before.json" "$WORK/after.json"

log "prune (other OS / other architecture prebuilds only)"
du -sb "$R/opt/dsh" | cut -f1 > "$WORK/harness-bytes-before"
python3 "$HERE/prune.py" "$R/opt/dsh/node_modules" "$NODEARCH" "$OUT/prune-$ABI.json"
du -sb "$R/opt/dsh" | cut -f1 > "$WORK/harness-bytes-after"
log "harness tree $(cat "$WORK/harness-bytes-before") -> $(cat "$WORK/harness-bytes-after") bytes"

########################################################################
log "ELF alignment (min 16 KB, ${STRICT:-report only})"
python3 "$HERE/check-elf-alignment.py" --machine "$MACHINE" --min 16384 $STRICT \
  --json "$OUT/alignment-$ABI.json" "$R"

log "pack harness layer"
EXCLUDES=()
pack "dsh-runtime-harness-$ABI" opt/dsh usr/local/bin/dsh

python3 - "$OUT/layers-$ABI.json" <<EOF
import json, hashlib, os, sys
out = "$OUT"
def info(name, layer_id):
    p = os.path.join(out, name + ".tar.zst")
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    stats = json.load(open(os.path.join("$WORK", name + ".stats.json")))
    return {"file": name + ".tar.zst", "id": layer_id, "size": os.path.getsize(p), "sha256": h.hexdigest(),
            "unpackedSize": stats["fileBytes"], "entries": stats["entries"], "stats": stats}
prune = json.load(open(os.path.join(out, "prune-$ABI.json")))
align = json.load(open(os.path.join(out, "alignment-$ABI.json")))
doc = {"abi": "$ABI", "debianArch": "$DEBARCH", "debianSuite": "$DEBIAN_SUITE", "debianSnapshot": "$DEBIAN_SNAPSHOT",
       "nodeVersion": "$NODE_VERSION", "harnessVersion": "$HARNESS_VERSION", "baseId": "$BASE_ID",
       "sourceDateEpoch": $SOURCE_DATE_EPOCH,
       "base": info("dsh-runtime-base-$ABI", "$BASE_ID"),
       "harness": info("dsh-runtime-harness-$ABI", "dsh-$HARNESS_VERSION"),
       "prune": {"removedBytes": prune["removedBytes"], "removedFiles": prune["removedFiles"],
                 "removed": [r["path"] for r in prune["removed"]],
                 "harnessBytesBefore": int(open("$WORK/harness-bytes-before").read()),
                 "harnessBytesAfter": int(open("$WORK/harness-bytes-after").read())},
       "alignment": {"checked": align["checked"], "aligned": align["aligned"], "below": len(align["below"]),
                     "histogram": align["histogram"], "strict": bool("$STRICT")}}
json.dump(doc, open(sys.argv[1], "w"), indent=2)
EOF
cat "$OUT/layers-$ABI.json"
log "done"
