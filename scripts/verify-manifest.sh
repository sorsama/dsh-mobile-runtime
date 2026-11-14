#!/usr/bin/env bash
# Verifies a runtime manifest signature with OpenSSL 3.
#
# Usage: verify-manifest.sh manifest.json manifest.json.sig [public-key.pem]
#   The default key is keys/runtime-signing-ed25519.pub.pem from this repository.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
M=$1; S=$2; K=${3:-$HERE/../keys/runtime-signing-ed25519.pub.pem}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
tr -d ' \r\n\t' < "$S" | base64 -d > "$TMP/sig.bin"
openssl pkeyutl -verify -pubin -inkey "$K" -rawin -in "$M" -sigfile "$TMP/sig.bin"
