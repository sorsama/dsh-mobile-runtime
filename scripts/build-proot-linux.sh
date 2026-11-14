#!/usr/bin/env bash
# Builds the same proot commit natively for the CI runner (glibc), used only by
# the smoke test. Same loader setup as Android: unbundled loader, PROOT_LOADER at run time.
#
# Usage: build-proot-linux.sh <out-dir>     (writes <out-dir>/proot and <out-dir>/loader)
# Needs: gcc, make, libtalloc-dev, curl.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=versions.env
. "$HERE/versions.env"

OUT=$(realpath -m "$1")
WORK=$(realpath -m "${WORK:-$PWD/work/proot-linux}")
rm -rf "$WORK"; mkdir -p "$OUT" "$WORK/src"
TGZ=$WORK/proot.tar.gz
curl -fsSL --retry 5 --retry-all-errors -o "$TGZ" "$PROOT_REPO/archive/$PROOT_COMMIT.tar.gz"
echo "$PROOT_SRC_SHA256  $TGZ" | sha256sum -c --quiet -
tar -xzf "$TGZ" -C "$WORK/src" --strip-components=1

env CPPFLAGS="-DVERSION=\\\"$PROOT_VERSION\\\"" \
  make -C "$WORK/src/src" -j"$(nproc)" CC=gcc GIT=false HAS_LOADER_32BIT= \
    PROOT_UNBUNDLE_LOADER="$PROOT_UNBUNDLE_LOADER" proot loader/loader >"$WORK/make.log" 2>&1 \
  || { tail -40 "$WORK/make.log"; exit 1; }
install -m 755 "$WORK/src/src/proot" "$OUT/proot"
install -m 755 "$WORK/src/src/loader/loader" "$OUT/loader"
PROOT_LOADER="$OUT/loader" "$OUT/proot" --version | head -3
