#!/usr/bin/env bash
# Signs <release-dir>/manifest.json with Ed25519 and writes manifest.json.sig
# (base64 of the 64-byte signature) and SHA256SUMS.txt for every asset.
#
# Usage: RUNTIME_SIGNING_KEY="$(cat key.pem)" sign-manifest.sh <release-dir>
# Needs OpenSSL 3 (pkeyutl -rawin).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
D=$(realpath "$1")
: "${RUNTIME_SIGNING_KEY:?set RUNTIME_SIGNING_KEY to the PEM private key}"

umask 077
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
printf '%s\n' "$RUNTIME_SIGNING_KEY" > "$TMP/key.pem"
openssl pkeyutl -sign -inkey "$TMP/key.pem" -rawin -in "$D/manifest.json" -out "$TMP/sig.bin"
rm -f "$TMP/key.pem"
[ "$(stat -c %s "$TMP/sig.bin")" = 64 ] || { echo "unexpected signature size" >&2; exit 1; }
base64 -w0 "$TMP/sig.bin" > "$D/manifest.json.sig"
umask 022

# The secret must match the public key committed to this repository.
"$HERE/verify-manifest.sh" "$D/manifest.json" "$D/manifest.json.sig" "$HERE/../keys/runtime-signing-ed25519.pub.pem"

(cd "$D" && find . -maxdepth 1 -type f ! -name SHA256SUMS.txt ! -name release-notes.md -printf '%f\n' \
   | LC_ALL=C sort | xargs sha256sum > SHA256SUMS.txt)
cat "$D/SHA256SUMS.txt"
