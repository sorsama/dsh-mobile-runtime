#!/bin/sh
# pnpm and pnpx for the DSH Mobile runtime. build-layers.sh installs this file as
# /usr/local/bin/pnpm and /usr/local/bin/pnpx.
#
# It is the same program `corepack enable --install-directory /usr/local/bin pnpm` would link
# (Node's bundled corepack shim), with two things the phone cannot rely on being set by whoever
# starts the process:
#
# - COREPACK_HOME points at /opt/corepack, where the build already put the pinned pnpm (and the
#   native binary pnpm 12 downloads on its first run). The default, ~/.cache/node/corepack,
#   would be empty on a phone and would need the network on first use. A COREPACK_HOME set by
#   the caller wins.
# - Corepack never asks before downloading (COREPACK_ENABLE_DOWNLOAD_PROMPT=0, there is no
#   terminal to answer on) and never rewrites a project's package.json (COREPACK_ENABLE_AUTO_PIN=0).
#
# With no `packageManager` field in the project, corepack runs the version `corepack prepare
# --activate` recorded at build time (/opt/corepack/lastKnownGood.json). A project that pins
# another pnpm gets that one, downloaded on demand.
COREPACK_HOME=${COREPACK_HOME:-/opt/corepack}
export COREPACK_HOME
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_ENABLE_AUTO_PIN=0
case "${0##*/}" in
  pnpx) tool=pnpx ;;
  *) tool=pnpm ;;
esac
exec /opt/node/bin/node "/opt/node/lib/node_modules/corepack/dist/$tool.js" "$@"
