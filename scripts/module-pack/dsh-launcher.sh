#!/bin/sh
# DeepSeek Harness launcher (DSH Mobile runtime). exec keeps the PID, so the app
# can stop the harness by signalling the guest's main process.
#
# The module pack (see README, "Startup: the module pack") is on by default and
# DSH_RUNTIME_MODULE_PACK=0 turns it off. The pack only changes how fast Node.js finds and
# reads files under /opt/dsh; the process that runs is always node.
P=/opt/dsh/runtime-pack/preload.mjs
case "${DSH_RUNTIME_MODULE_PACK:-1}" in
  0|[Oo][Ff][Ff]|[Ff][Aa][Ll][Ss][Ee]|[Nn][Oo]) ;;
  *) [ -f "$P" ] && exec /opt/node/bin/node --import "$P" /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js "$@" ;;
esac
exec /opt/node/bin/node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
