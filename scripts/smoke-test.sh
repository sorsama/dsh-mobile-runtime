#!/usr/bin/env bash
# Unpacks the two layers like the app will, then runs the harness under proot with
# the same flags and environment as the app, as an unprivileged user.
#
# Usage: smoke-test.sh <abi> <layers-dir> <proot-dir> <result.json>
#   <proot-dir> holds `proot` and `loader` from build-proot-linux.sh.
# The launch token is masked in the CI log and never written to any output file.
set -euo pipefail
ABI=$1; LAYERS=$(realpath "$2"); PD=$(realpath "$3"); RESULT=$(realpath -m "$4")
WORK=$(realpath -m "${WORK:-$PWD/work/smoke-$ABI}")
PORT=3080
R=$WORK/rootfs
LOG=$WORK/harness.log
if [ -d "$WORK" ]; then chmod -R u+w "$WORK" 2>/dev/null || true; rm -rf "$WORK"; fi
mkdir -p "$R" "$WORK/proot-tmp"

now() { date +%s.%N; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", b - a }'; }
redact() { sed -E 's/token=[A-Za-z0-9._~%-]+/token=<redacted>/g; s/(dsh-auth-[^=;]*=)[^;[:space:]]+/\1<redacted>/g'; }

t=$(now)
zstd -dc --long=27 "$LAYERS/dsh-runtime-base-$ABI.tar.zst" | tar -xf - -C "$R"
zstd -dc --long=27 "$LAYERS/dsh-runtime-harness-$ABI.tar.zst" | tar -xf - -C "$R"
EXTRACT=$(secs "$t" "$(now)")
echo "extracted both layers in ${EXTRACT}s ($(du -sh "$R" | cut -f1))"

# The exact command line of the app (spike report, section 5), plus the fake /proc files.
export PROOT_LOADER=$PD/loader PROOT_TMP_DIR=$WORK/proot-tmp
unset PROOT_NO_SECCOMP
# Always called in a subshell (pipeline or &): exec makes that subshell proot itself,
# so $! is proot's PID, as it is for the app's Process.
proot_run() {
  exec "$PD/proot" --kill-on-exit --link2symlink -0 \
    -r "$R" \
    -b /dev -b /proc -b /sys -b /proc/self/fd:/dev/fd -b "$R/tmp:/dev/shm" \
    -b "$R/opt/dsh-runtime/proc/stat:/proc/stat" \
    -b "$R/opt/dsh-runtime/proc/loadavg:/proc/loadavg" \
    -b "$R/opt/dsh-runtime/proc/uptime:/proc/uptime" \
    -w /root \
    /usr/bin/env -i HOME=/root USER=root LOGNAME=root \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
      LANG=C.UTF-8 TERM=dumb TMPDIR=/tmp \
    /bin/bash -c "$1"
}

echo "== guest checks"
proot_run 'umask 022; set -e
  echo "uid: $(id -u)"; node -v; git --version; rg --version | head -1; curl --version | head -1
  dsh --version
  node -e "const os=require(\"os\"); console.log(\"os.cpus\", os.cpus().length, \"loadavg\", os.loadavg().length)"
  cd /tmp && rm -rf hl && mkdir hl && cd hl && echo x > a && ln a b && cat b >/dev/null && echo "hard link ok"
  cd /tmp && rm -rf g && git init -q g && cd g && git config user.email ci@example.invalid && git config user.name ci \
    && echo hi > f && git add f && git commit -qm init && echo "git commit ok"
  printf "#!/usr/bin/env node\nconsole.log(\"node shebang ok\")\n" > /tmp/n.js && chmod +x /tmp/n.js && /tmp/n.js
  rm -rf /tmp/g /tmp/n.js
  # Known proot quirk: rm -rf of a directory that holds link2symlink files can fail
  # once with "Directory not empty" (the hidden .l2s. file moves while rm reads the
  # directory). A second rm succeeds. Report it instead of failing.
  rm -rf /tmp/hl 2>/dev/null || { echo "note: first rm -rf of the hard link dir failed (link2symlink quirk)"; rm -rf /tmp/hl; }
  echo "cleanup ok"' 2>&1 | tee "$WORK/guest-checks.txt"
CPUS=$(sed -n 's/^os.cpus \([0-9]*\).*/\1/p' "$WORK/guest-checks.txt")
[ "${CPUS:-0}" -gt 0 ] || { echo "os.cpus() is empty" >&2; exit 1; }
RM_RETRY=$(grep -q "link2symlink quirk" "$WORK/guest-checks.txt" && echo true || echo false)
grep -q "^cleanup ok" "$WORK/guest-checks.txt" || { echo "guest checks did not finish" >&2; exit 1; }

PROOT_PID=
start_harness() {
  : > "$LOG"
  T_START=$(now)
  proot_run "umask 022; mkdir -p /root/work && cd /root/work && exec dsh web --no-open --port $PORT" >"$LOG" 2>&1 &
  PROOT_PID=$!
  local deadline=$(( $(date +%s) + 600 ))
  until grep -q "dsh web: http://127.0.0.1:$PORT/?token=" "$LOG"; do
    if ! kill -0 "$PROOT_PID" 2>/dev/null; then echo "harness exited early:"; redact < "$LOG" | tail -40; exit 1; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then echo "no readiness line after 600 s:"; redact < "$LOG" | tail -40; exit 1; fi
    sleep 0.1
  done
  READY=$(secs "$T_START" "$(now)")
  TOKEN=$(sed -n "s|.*dsh web: http://127.0.0.1:$PORT/?token=\([^[:space:]]*\).*|\1|p" "$LOG" | head -1)
  [ -n "$TOKEN" ] || { echo "could not read the token" >&2; exit 1; }
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$TOKEN"
  echo "readiness line after ${READY}s"
}

# Stop sequence from the report: SIGTERM the guest's main process (proot ignores
# SIGTERM), then SIGQUIT proot, then SIGKILL whatever is left.
stop_harness() {
  local guest
  guest=$(pgrep -P "$PROOT_PID" || true)
  [ -n "$guest" ] && kill -TERM $guest 2>/dev/null || true
  for _ in $(seq 1 50); do kill -0 "$PROOT_PID" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$PROOT_PID" 2>/dev/null; then kill -QUIT "$PROOT_PID" 2>/dev/null || true; sleep 1; fi
  if kill -0 "$PROOT_PID" 2>/dev/null; then kill -KILL "$PROOT_PID" 2>/dev/null || true; STOP=forced; else STOP=clean; fi
  wait "$PROOT_PID" 2>/dev/null || true
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then echo "port $PORT still answers after stop" >&2; exit 1; fi
  echo "stopped ($STOP)"
}

envelope() { printf '{"type":"client-request","rpcId":"ci-%s","method":"%s","payload":%s}' "$RANDOM" "$1" "$2"; }

echo "== run 1 (first start after extraction)"
start_harness
FIRST=$READY
B=http://127.0.0.1:$PORT
C1=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
      --data "$(envelope session/list '{"_request":{}}')" "$B/api/session/list")
echo "no-cookie POST /api/session/list -> $C1"
JAR=$WORK/cookies.txt; rm -f "$JAR"
C2=$(curl -s -o /dev/null -c "$JAR" -w '%{http_code}' "$B/?token=$TOKEN")
echo "GET /?token=<redacted> -> $C2"
grep -q 'dsh-auth-' "$JAR" || { echo "no dsh-auth cookie was set" >&2; exit 1; }
BODY=$WORK/list.json
C3=$(curl -s -o "$BODY" -b "$JAR" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
      --data "$(envelope session/list '{"args":{"_request":{}}}')" "$B/api/session/list")
echo "cookie POST /api/session/list -> $C3 $(head -c 200 "$BODY" | redact)"
rm -f "$JAR"
stop_harness
STOP1=$STOP
[ "$C1" = 401 ] || { echo "expected 401 without a session, got $C1" >&2; exit 1; }
[ "$C2" = 303 ] || [ "$C2" = 302 ] || { echo "expected a redirect from the token exchange, got $C2" >&2; exit 1; }
[ "$C3" = 200 ] && grep -q '"ok":true' "$BODY" || { echo "authenticated session/list failed" >&2; exit 1; }

echo "== run 2 (warm start)"
start_harness
WARM=$READY
stop_harness
redact < "$LOG" > "$WORK/harness-redacted.log"
unset TOKEN

cat > "$RESULT" <<EOF
{"abi": "$ABI", "runner": "$(uname -m) $(nproc) CPUs", "extractSeconds": $EXTRACT,
 "firstStartToReadySeconds": $FIRST, "warmStartToReadySeconds": $WARM,
 "unauthenticatedStatus": $C1, "tokenExchangeStatus": $C2, "sessionListStatus": $C3,
 "stop": "$STOP1", "osCpus": $CPUS, "l2sRmRetryNeeded": $RM_RETRY}
EOF
cat "$RESULT"
