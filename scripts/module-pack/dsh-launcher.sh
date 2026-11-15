#!/bin/sh
# DeepSeek Harness launcher (DSH Mobile runtime). exec keeps the PID, so the app
# can stop the harness by signalling the guest's main process.
#
# Two things happen here before node starts (README, "Startup" and "Shell commands and
# permissions on Android"):
#
# 1. The module pack is on by default and DSH_RUNTIME_MODULE_PACK=0 turns it off. The pack only
#    changes how fast Node.js finds and reads files under /opt/dsh; the process that runs is
#    always node.
# 2. `dsh web ...` gets `--patch /opt/dsh/mobile/android.patch.yml`: the two permission presets
#    for Android (Full access, Ask before commands). DSH_RUNTIME_MOBILE_PATCH=0 leaves it out and
#    the harness behaves exactly as upstream ships it. DSH_RUNTIME_DEFAULT_PERMISSION (full or
#    ask) is read by the patch itself; this script only warns about a value it does not know.
M=/opt/dsh/mobile/android.patch.yml
case "${DSH_RUNTIME_MOBILE_PATCH:-1}" in
  0|[Oo][Ff][Ff]|[Ff][Aa][Ll][Ss][Ee]|[Nn][Oo]) ;;
  *)
    if [ "${1:-}" = web ]; then
      if [ -f "$M" ]; then
        shift
        set -- web --patch "$M" "$@"
        case "$(printf %s "${DSH_RUNTIME_DEFAULT_PERMISSION:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
          ''|full|danger-full-access|ask) ;;
          *) echo "dsh: warning: DSH_RUNTIME_DEFAULT_PERMISSION is not 'full' or 'ask', so new sessions start on 'Ask before commands'" >&2 ;;
        esac
      else
        echo "dsh: warning: $M is missing, starting without the Android permission presets" >&2
      fi
    fi ;;
esac
P=/opt/dsh/runtime-pack/preload.mjs
case "${DSH_RUNTIME_MODULE_PACK:-1}" in
  0|[Oo][Ff][Ff]|[Ff][Aa][Ll][Ss][Ee]|[Nn][Oo]) ;;
  *) [ -f "$P" ] && exec /opt/node/bin/node --import "$P" /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js "$@" ;;
esac
exec /opt/node/bin/node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
