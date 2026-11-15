#!/usr/bin/env bash
# Unpacks the two layers like the app will, then runs the harness under proot with
# the same flags and environment as the app, as an unprivileged user.
#
# Usage: smoke-test.sh <abi> <layers-dir> <proot-dir> <result.json>
#   <proot-dir> holds `proot` and `loader` from build-proot-linux.sh.
# The launch token is masked in the CI log and never written to any output file.
#
# What it proves (any failure stops the build, so nothing is released):
#   1. the guest tools work (git, ripgrep, hard links, os.cpus());
#   2. the harness starts with the module pack ON (the default) and OFF
#      (DSH_RUNTIME_MODULE_PACK=0) and in both: 401 without a session, token exchange,
#      authenticated calls; and the two modes return the same JSON for the same calls
#      apart from ids and timestamps;
#   3. a stale pack, a truncated pack, a damaged pack head, a missing pack, a missing
#      preload and a preload that throws all leave a working harness, and the pack says
#      so on stderr and never on stdout;
#   4. a module outside /opt/dsh is read from disk, not from the pack;
#   5. shell commands and permissions, with a scripted fake model that makes the real harness call
#      its real tools: Full access runs a shell command without asking; Ask before commands holds it
#      for an approval that carries the command (allow runs it once, reject and cancel run nothing);
#      file tools, subagents, plugin_manager, the persistent shell and code mode behave as documented
#      in both presets; DSH_RUNTIME_DEFAULT_PERMISSION switches the default both ways; the escape hatch
#      DSH_RUNTIME_MOBILE_PATCH=0 gives back upstream's refusal (SANDBOX_UNAVAILABLE); and the
#      permission module broken in five ways never lets a command run unasked (fail closed);
#   6. start-to-readiness is measured 3 times for pack on and pack off, and the path
#      system calls of one start of each are counted when strace and sudo are available.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ABI=$1; LAYERS=$(realpath "$2"); PD=$(realpath "$3"); RESULT=$(realpath -m "$4")
WORK=$(realpath -m "${WORK:-$PWD/work/smoke-$ABI}")
PORT=3080
R=$WORK/rootfs
LOG=$WORK/harness.log
ERR=$WORK/harness.err
if [ -d "$WORK" ]; then chmod -R u+w "$WORK" 2>/dev/null || true; rm -rf "$WORK"; fi
mkdir -p "$R" "$WORK/proot-tmp" "$WORK/out"

now() { date +%s.%N; }
secs() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.2f", b - a }'; }
redact() { sed -E 's/token=[A-Za-z0-9._~%-]+/token=<redacted>/g; s/(dsh-auth-[^=;]*=)[^;[:space:]]+/\1<redacted>/g'; }
median3() { printf '%s\n' "$@" | sort -n | sed -n 2p; }

# On any failure, say whether the harness's Node.js requirement (engines.node) is met by the
# bundled Node.js. A harness that needs a newer Node.js is the usual reason a bundle does not start.
node_hint() {
  local rc=$?
  [ "$rc" -ne 0 ] || return 0
  local engines bundled
  engines=$(jq -r '.engines.node // ""' "$R/opt/dsh/node_modules/@deepseek-ai/dsh/package.json" 2>/dev/null || true)
  bundled=$(jq -r '.nodeVersion // ""' "$R/opt/dsh-runtime/base.json" 2>/dev/null || true)
  [ -n "$bundled" ] || return 0
  local msg="Node.js check: harness asks for '${engines:-nothing}', bundle ships Node $bundled."
  if command -v node >/dev/null 2>&1; then
    msg=$(node "$HERE/node-engine.mjs" explain "$engines" "$bundled" 2>/dev/null || echo "$msg")
  fi
  echo "::error title=Smoke test failed::$msg See the log above for the step that failed."
  echo "$msg" >&2
}
trap node_hint EXIT

t=$(now)
zstd -dc --long=27 "$LAYERS/dsh-runtime-base-$ABI.tar.zst" | tar -xf - -C "$R"
zstd -dc --long=27 "$LAYERS/dsh-runtime-harness-$ABI.tar.zst" | tar -xf - -C "$R"
EXTRACT=$(secs "$t" "$(now)")
echo "extracted both layers in ${EXTRACT}s ($(du -sh "$R" | cut -f1))"
BUILD_ID=$(tr -d '[:space:]' < "$R/opt/dsh/build-id")
PACKDIR=$R/opt/dsh/runtime-pack
echo "module pack build id $BUILD_ID, $(stat -c %s "$PACKDIR/pack.bin") bytes"

# The exact command line of the app (spike report, section 5), plus the fake /proc files.
# GUEST_ENV adds variables to the guest's `env -i` list (for example DSH_RUNTIME_MODULE_PACK=0).
export PROOT_LOADER=$PD/loader PROOT_TMP_DIR=$WORK/proot-tmp
unset PROOT_NO_SECCOMP
GUEST_ENV=
# Always called in a subshell (pipeline or &): exec makes that subshell proot itself,
# so $! is proot's PID, as it is for the app's Process.
proot_run() {
  # shellcheck disable=SC2086
  exec "$PD/proot" --kill-on-exit --link2symlink -0 \
    -r "$R" \
    -b /dev -b /proc -b /sys -b /proc/self/fd:/dev/fd -b "$R/tmp:/dev/shm" \
    -b "$R/opt/dsh-runtime/proc/stat:/proc/stat" \
    -b "$R/opt/dsh-runtime/proc/loadavg:/proc/loadavg" \
    -b "$R/opt/dsh-runtime/proc/uptime:/proc/uptime" \
    -w /root \
    /usr/bin/env -i HOME=/root USER=root LOGNAME=root \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin \
      LANG=C.UTF-8 TERM=dumb TMPDIR=/tmp $GUEST_ENV \
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
B=http://127.0.0.1:$PORT
# The harness keeps its state under /root/.dsh. Every start gets a clean one, so the
# responses of different starts can be compared.
reset_state() { rm -rf "$R/root/.dsh" "$R/tmp/pack-ws"; mkdir -p "$R/tmp/pack-ws"; }
fail_with_logs() {
  echo "$1" >&2
  echo "--- harness stdout (redacted)"; redact < "$LOG" | tail -40
  echo "--- harness stderr (redacted)"; redact < "$ERR" | tail -40
  exit 1
}
# start_harness [pack-env-value]: starts the harness through /usr/local/bin/dsh, like the app.
# EXTRA_ENV (more NAME=value words for the guest's `env -i` list) and HARNESS_ARGS (the arguments
# of dsh, default "web --no-open --port <port>") are set only by the shell permission tests.
start_harness() {
  GUEST_ENV="${1:+DSH_RUNTIME_MODULE_PACK=$1} ${EXTRA_ENV:-}"
  : > "$LOG"; : > "$ERR"
  T_START=$(now)
  proot_run "umask 022; mkdir -p /root/work && cd /root/work && exec dsh ${HARNESS_ARGS:-web --no-open --port $PORT}" >"$LOG" 2>"$ERR" &
  PROOT_PID=$!
  local deadline=$(( $(date +%s) + 600 ))
  until grep -q "dsh web: http://127.0.0.1:$PORT/?token=" "$LOG"; do
    if ! kill -0 "$PROOT_PID" 2>/dev/null; then fail_with_logs "harness exited early"; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then fail_with_logs "no readiness line after 600 s"; fi
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

# Ids, timestamps and the like differ between starts; everything else must be equal.
normalize() {
  sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<uuid>/g;
          s/"rpcId":"[^"]*"/"rpcId":"<id>"/g;
          s/"entryId":"[0-9a-f]{8}"/"entryId":"<id>"/g;
          s/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/<iso>/g;
          s/(:|\[|,)1[0-9]{12}(,|\}|\])/\1<ms>\2/g;
          s/(:|\[|,)1[0-9]{9}(,|\}|\])/\1<s>\2/g' \
  | redact
}

# check_session <label>: 401 without a session, token exchange, authenticated session/list.
CHECKS=
check_session() {
  local jar=$WORK/cookies.txt body=$WORK/list.json c1 c2 c3
  c1=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
        --data "$(envelope session/list '{"_request":{}}')" "$B/api/session/list")
  rm -f "$jar"
  c2=$(curl -s -o /dev/null -c "$jar" -w '%{http_code}' "$B/?token=$TOKEN")
  grep -q 'dsh-auth-' "$jar" || { echo "no dsh-auth cookie was set" >&2; exit 1; }
  c3=$(curl -s -o "$body" -b "$jar" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
        --data "$(envelope session/list '{"args":{"_request":{}}}')" "$B/api/session/list")
  echo "$1: no-cookie $c1, token exchange $c2, authenticated session/list $c3 $(head -c 120 "$body" | redact)"
  rm -f "$jar"
  [ "$c1" = 401 ] || { echo "expected 401 without a session, got $c1" >&2; exit 1; }
  [ "$c2" = 303 ] || [ "$c2" = 302 ] || { echo "expected a redirect from the token exchange, got $c2" >&2; exit 1; }
  [ "$c3" = 200 ] && grep -q '"ok":true' "$body" || { echo "authenticated session/list failed" >&2; exit 1; }
  C1=$c1; C2=$c2; C3=$c3
}

# run_calls <dir>: the calls of module-pack/calls.json with a session cookie; responses are
# written, normalized, to <dir>/NN-method.json.
run_calls() {
  local dir=$1 jar=$WORK/cookies.txt n=0 sid= method args code out
  mkdir -p "$dir"; rm -f "$jar"
  curl -s -o /dev/null -c "$jar" "$B/?token=$TOKEN"
  while IFS= read -r line; do
    n=$((n + 1))
    method=$(jq -r '.method' <<< "$line")
    args=$(jq -c --arg ws /tmp/pack-ws --arg sid "$sid" '(.args | tostring | gsub("@WORKSPACE@"; $ws) | gsub("@SESSION_ID@"; $sid) | fromjson)' <<< "$line")
    code=$(curl -s -o "$dir/raw" -b "$jar" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
            --data "$(envelope "$method" "{\"args\":$args}")" "$B/api/$method")
    [ "$code" = 200 ] || { echo "call $method returned HTTP $code" >&2; exit 1; }
    if [ "$(jq -r '.save // empty' <<< "$line")" = sessionId ]; then sid=$(jq -r '.result.value.sessionId' "$dir/raw"); fi
    out=$dir/$(printf '%02d' "$n")-${method//\//_}.json
    normalize < "$dir/raw" > "$out"
    if [ "$method" = pluginManager/listPlugins ]; then
      # The list follows the order in which plugins finished starting, which depends on timing
      # and differs from start to start (also with the pack off). Compare it as a set.
      jq -c '.result.value |= (map(tostring) | sort)' "$out" > "$out.tmp" && mv "$out.tmp" "$out"
    fi
  done < <(jq -c '.calls[]' "$HERE/module-pack/calls.json")
  rm -f "$dir/raw" "$jar"
  local ok; ok=$(grep -l '"ok":true' "$dir"/*.json | wc -l)
  echo "$n calls made, $ok answered ok:true"
  CALLS_N=$n; CALLS_OK=$ok
}

stdout_clean() { # the app parses stdout: nothing of the pack may appear there
  if grep -q "module pack" "$LOG"; then fail_with_logs "the module pack wrote to stdout"; fi
}

########################################################################
echo "== run 1: pack on (default), first start after extraction"
reset_state
start_harness
FIRST=$READY
check_session "pack on"
run_calls "$WORK/out/on"
ON_OK=$CALLS_OK
stdout_clean
stop_harness
STOP1=$STOP
C1_ON=$C1; C2_ON=$C2; C3_ON=$C3

echo "== run 2: pack off (DSH_RUNTIME_MODULE_PACK=0)"
reset_state
start_harness 0
check_session "pack off"
run_calls "$WORK/out/off"
OFF_OK=$CALLS_OK
stop_harness

echo "== same calls, pack on vs pack off"
[ "$ON_OK" = "$OFF_OK" ] || { echo "different calls answered ok: $ON_OK with the pack, $OFF_OK without" >&2; exit 1; }
if ! diff -r "$WORK/out/on" "$WORK/out/off" > "$WORK/out/diff.txt"; then
  echo "FAIL: responses differ between pack on and pack off:" >&2; head -60 "$WORK/out/diff.txt" >&2; exit 1
fi
echo "all $CALLS_N responses identical apart from ids and timestamps ($ON_OK answered ok:true)"
EQUAL=true

########################################################################
echo "== degraded packs: the harness must still start, and say why on stderr"
degraded() { # <label> <expected stderr text>
  reset_state
  start_harness
  check_session "$1"
  stdout_clean
  if [ -n "$2" ]; then
    grep -q "$2" "$ERR" || fail_with_logs "$1: expected '$2' on stderr"
    echo "$1: stderr says: $(grep 'module pack' "$ERR" | head -1)"
  fi
  stop_harness
}
cp "$PACKDIR/pack.bin" "$WORK/pack.bin.orig"; cp "$R/opt/dsh/build-id" "$WORK/build-id.orig"
cp "$PACKDIR/replay.mjs" "$WORK/replay.mjs.orig"; cp "$PACKDIR/preload.mjs" "$WORK/preload.mjs.orig"
restore_pack() {
  cp "$WORK/pack.bin.orig" "$PACKDIR/pack.bin"; cp "$WORK/build-id.orig" "$R/opt/dsh/build-id"
  cp "$WORK/replay.mjs.orig" "$PACKDIR/replay.mjs"; cp "$WORK/preload.mjs.orig" "$PACKDIR/preload.mjs"
}
SIZE=$(stat -c %s "$PACKDIR/pack.bin")

echo "build id file changed (stale pack)"
echo "0000-not-the-build-id" > "$R/opt/dsh/build-id"; degraded "stale pack" "build id does not match"; restore_pack
echo "pack truncated to half"
truncate -s $((SIZE / 2)) "$PACKDIR/pack.bin"; degraded "truncated pack" "module pack: off"; restore_pack
echo "pack truncated to 5 bytes"
truncate -s 5 "$PACKDIR/pack.bin"; degraded "tiny pack" "module pack: off"; restore_pack
echo "pack head overwritten with zeros"
head -c 4096 /dev/zero | dd of="$PACKDIR/pack.bin" bs=4096 count=1 conv=notrunc 2>/dev/null; degraded "zeroed pack head" "module pack: off"; restore_pack
echo "pack file removed"
rm -f "$PACKDIR/pack.bin"; degraded "missing pack" "module pack: off"; restore_pack
echo "build id file removed"
rm -f "$R/opt/dsh/build-id"; degraded "missing build id" "module pack: off"; restore_pack
echo "replay module throws"
printf 'throw new Error("boom");\n' > "$PACKDIR/replay.mjs"; degraded "throwing preload" "preload failed"; restore_pack
echo "replay module has a syntax error"
printf 'export default {{{;\n' > "$PACKDIR/replay.mjs"; degraded "broken preload" "preload failed"; restore_pack
echo "preload file removed (the launcher falls back to plain node)"
rm -f "$PACKDIR/preload.mjs"; degraded "missing preload" ""; restore_pack
echo "the degraded cases above restored the pack:"
cmp "$WORK/pack.bin.orig" "$PACKDIR/pack.bin" && echo "pack restored"
DEGRADED=9

########################################################################
echo "== a module outside /opt/dsh comes from disk, never from the pack"
OUTSIDE=$R/root/pack-outside
rm -rf "$OUTSIDE"; mkdir -p "$OUTSIDE/node_modules/outside-pkg" "$OUTSIDE/node_modules/semver"
printf '{"name":"outside-pkg","version":"1.0.0","type":"module","exports":"./index.js"}\n' > "$OUTSIDE/node_modules/outside-pkg/package.json"
# A package that has the name of one the harness itself uses: the user's copy must win here.
printf '{"name":"semver","version":"0.0.1","type":"module","exports":"./index.js"}\n' > "$OUTSIDE/node_modules/semver/package.json"
printf 'export default "semver-outside";\n' > "$OUTSIDE/node_modules/semver/index.js"
cat > "$OUTSIDE/check.mjs" <<'EOF'
import fs from 'node:fs';
import outside from 'outside-pkg';
import semver from 'semver';
// An in-tree file first, so the pack has something to serve and we can see the difference.
const inTree = await import('/opt/dsh/node_modules/@deepseek-ai/dsh-base/package.json', { with: { type: 'json' } });
const pj = JSON.parse(fs.readFileSync('/root/pack-outside/node_modules/outside-pkg/package.json', 'utf8'));
console.log(JSON.stringify({ outside, semver, version: pj.version, inTree: inTree.default.name, exists: fs.existsSync('/root/pack-outside/node_modules/outside-pkg/index.js') }));
EOF
run_outside() { # <expected value>
  printf 'export default "%s";\n' "$1" > "$OUTSIDE/node_modules/outside-pkg/index.js"
  sed -i -E "s/\"version\":\"[^\"]*\"/\"version\":\"$1\"/" "$OUTSIDE/node_modules/outside-pkg/package.json"
  ( GUEST_ENV="DSH_RUNTIME_MODULE_PACK_DEBUG=1 DSH_RUNTIME_MODULE_PACK_MISSES=/tmp/outside-misses.txt"
    proot_run 'cd /root/pack-outside && node --import /opt/dsh/runtime-pack/preload.mjs check.mjs' ) > "$WORK/outside.out" 2> "$WORK/outside.err" \
    || { cat "$WORK/outside.out" "$WORK/outside.err"; echo "outside check failed to run" >&2; exit 1; }
  grep -q 'module pack: on:' "$WORK/outside.err" || { cat "$WORK/outside.err"; echo "the pack was not on" >&2; exit 1; }
  grep -q "\"outside\":\"$1\"" "$WORK/outside.out" && grep -q '"semver":"semver-outside"' "$WORK/outside.out" \
    && grep -q "\"version\":\"$1\"" "$WORK/outside.out" && grep -q '"exists":true' "$WORK/outside.out" \
    || { cat "$WORK/outside.out"; echo "outside-tree module did not come from disk" >&2; exit 1; }
  grep -q 'file:///root/pack-outside/node_modules/outside-pkg/index.js' "$R/tmp/outside-misses.txt" \
    || { cat "$R/tmp/outside-misses.txt"; echo "the outside module was not reported as a pack miss" >&2; exit 1; }
  echo "outside value $1 read from disk: $(cat "$WORK/outside.out") | $(grep 'stats:' "$WORK/outside.err")"
}
run_outside one
run_outside two   # same file, same path, new content: a pack would serve the old one
rm -rf "$OUTSIDE" "$R/tmp/outside-misses.txt"
OUTSIDE_OK=true

########################################################################
echo "== shell commands and permissions: real tool calls from a scripted fake model, under proot"
# A tiny local HTTP server plays the model (scripts/shell-tests/fake-model.mjs): it answers with the
# tool calls a scenario asks for, so the real harness runs its real tools. Approval questions are
# answered through the harness's own client protocol (answerer.mjs), like the app's approval panel.
# No network, no key. Everything runs in the guest, with the guest's Node.js.
ST=$R/tmp/shell-tests
FAKE_PORT=8766
FAKE_ENV="DEEPSEEK_API_KEY=sk-fake-ci-not-a-key DEEPSEEK_BASE_URL=http://127.0.0.1:$FAKE_PORT/anthropic"
SHELL_STARTS=0; SHELL_SCENARIOS=0; SHELL_CLOSED=0
rm -rf "$ST"; mkdir -p "$ST"
cp "$HERE"/shell-tests/*.mjs "$HERE"/shell-tests/scenarios/*.json "$ST/"

: > "$ST/fake.log"
( GUEST_ENV=; proot_run "exec node /tmp/shell-tests/fake-model.mjs /tmp/shell-tests/fake.log $FAKE_PORT" ) >"$WORK/fake-model.out" 2>&1 &
FAKE_PID=$!
for _ in $(seq 1 100); do grep -q '"listening"' "$ST/fake.log" && break; kill -0 "$FAKE_PID" 2>/dev/null || break; sleep 0.1; done
grep -q '"listening"' "$ST/fake.log" || { cat "$WORK/fake-model.out"; echo "the fake model did not start" >&2; exit 1; }
stop_fake() {
  local guest
  guest=$(pgrep -P "$FAKE_PID" || true)
  [ -n "$guest" ] && kill -TERM $guest 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$FAKE_PID" 2>/dev/null || break; sleep 0.1; done
  kill -KILL "$FAKE_PID" 2>/dev/null || true
  wait "$FAKE_PID" 2>/dev/null || true
}

# shell_phase <label> <scenario file> <extra env words> [dsh arguments]: a fresh harness start with
# an empty home and workspace, then every scenario of the file against it, then a clean stop.
shell_phase() {
  local label=$1 file=$2
  EXTRA_ENV="$FAKE_ENV $3"; HARNESS_ARGS=${4:-}
  reset_state
  rm -rf "$R/root/work"; rm -f "$R"/root/*.txt; mkdir -p "$R/root/work"
  : > "$ST/fake.log"
  echo "-- phase $label ($file; env: ${3:-none})"
  start_harness
  SHELL_STARTS=$((SHELL_STARTS + 1))
  if ! ( GUEST_ENV="DSH_TEST_TOKEN=$TOKEN"
         proot_run "cd /tmp/shell-tests && exec node scenarios.mjs --port $PORT --fake-log /tmp/shell-tests/fake.log --work /root/work --file /tmp/shell-tests/$file --out /tmp/shell-tests/result-$label.json" ) 2>&1 | tee "$WORK/shell-$label.txt"; then
    stop_fake || true
    fail_with_logs "shell permission scenarios failed in phase $label (see the FAIL lines above)"
  fi
  n=$(grep -c '^PASS' "$WORK/shell-$label.txt" || true)
  SHELL_SCENARIOS=$((SHELL_SCENARIOS + n))
  stop_harness
  unset EXTRA_ENV HARNESS_ARGS
}

# 1. The default start (DSH_RUNTIME_DEFAULT_PERMISSION unset): Full access, then every Ask before commands case.
shell_phase default default-full.json ""
SHELL_CATALOG=$(jq -c '.catalog' "$ST/result-default.json")
echo "preset catalog as the harness reports it: $SHELL_CATALOG"
# 2. The default switched to Ask before commands, and a value that is neither full nor ask.
shell_phase ask-default ask-default.json "DSH_RUNTIME_DEFAULT_PERMISSION=ask"
shell_phase unknown-default unknown-default.json "DSH_RUNTIME_DEFAULT_PERMISSION=banana"
grep -q "DSH_RUNTIME_DEFAULT_PERMISSION is not 'full' or 'ask'" "$ERR" || fail_with_logs "the launcher did not warn about an unknown DSH_RUNTIME_DEFAULT_PERMISSION"
# 3. The escape hatch: the harness exactly as upstream ships it, where the shell is refused.
shell_phase upstream upstream.json "DSH_RUNTIME_MOBILE_PATCH=0"

# 4. Fail closed. The same module, broken in five ways, is started in place of the shipped one (from
# a directory outside /opt/dsh, with the launcher's patch off and --patch given by hand). No variant
# may let a command run: the shell must be refused as upstream refuses it, or, when the module
# loads and only its gate fails, the call must end in an error, and nothing may be written.
echo "-- fail closed: the permission module cannot load, or breaks"
mkvariant() { # <name>: a directory with the shipped patch and no module yet
  rm -rf "$R/root/closed-$1"; mkdir -p "$R/root/closed-$1"; cp "$R/opt/dsh/mobile/android.patch.yml" "$R/root/closed-$1/"
}
# The shipped module with its import made absolute, so a copy outside /opt/dsh still finds the harness.
shipped_module() { sed "s#from '@deepseek-ai/dsh-permission-presets'#from 'file:///opt/dsh/node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js'#" "$R/opt/dsh/mobile/permission.mjs"; }
mkvariant missing
mkvariant syntax;  printf 'export default class {{{\n' > "$R/root/closed-syntax/permission.mjs"
mkvariant ctor;    shipped_module | sed "s/super(ctx, config)/super(ctx, config); throw new Error('constructor boom')/" > "$R/root/closed-ctor/permission.mjs"
mkvariant inject;  shipped_module | sed "s/'sandboxPolicy'\]/'sandboxPolicy', 'noSuchService']/" > "$R/root/closed-inject/permission.mjs"
mkvariant handler; shipped_module | sed "s/if (kind === undefined) return next()/if (kind === undefined) return next(); throw new Error('handler boom')/" > "$R/root/closed-handler/permission.mjs"
grep -q 'constructor boom' "$R/root/closed-ctor/permission.mjs" && grep -q 'noSuchService' "$R/root/closed-inject/permission.mjs" \
  && grep -q 'handler boom' "$R/root/closed-handler/permission.mjs" && grep -q 'file:///opt/dsh/node_modules' "$R/root/closed-handler/permission.mjs" \
  || { echo "the broken variants were not made (the shipped module changed shape)" >&2; exit 1; }
for v in missing syntax ctor inject; do
  # DSH_RUNTIME_DEFAULT_PERMISSION=full is what a user who wants no questions has; it must not matter.
  shell_phase "closed-$v" closed.json "DSH_RUNTIME_MOBILE_PATCH=0 DSH_RUNTIME_DEFAULT_PERMISSION=full" "web --patch /root/closed-$v/android.patch.yml --no-open --port $PORT"
  grep -q 'did not activate' "$ERR" || fail_with_logs "variant $v: the harness did not report the module as not active"
  SHELL_CLOSED=$((SHELL_CLOSED + 1))
done
shell_phase closed-handler closed-handler.json "DSH_RUNTIME_MOBILE_PATCH=0 DSH_RUNTIME_DEFAULT_PERMISSION=ask" "web --patch /root/closed-handler/android.patch.yml --no-open --port $PORT"
SHELL_CLOSED=$((SHELL_CLOSED + 1))
stop_fake
rm -rf "$R"/root/closed-* "$R"/root/work "$R"/root/*.txt; mkdir -p "$R/root/work"
echo "shell permission checks passed: $SHELL_SCENARIOS scenarios in $SHELL_STARTS harness starts ($SHELL_CLOSED fail-closed variants)"

########################################################################
echo "== start to readiness, median of 3, pack on and pack off (interleaved)"
ON_T=(); OFF_T=()
for i in 1 2 3; do
  reset_state; start_harness; ON_T+=("$READY"); stop_harness
  reset_state; start_harness 0; OFF_T+=("$READY"); stop_harness
done
ON_MED=$(median3 "${ON_T[@]}"); OFF_MED=$(median3 "${OFF_T[@]}")
echo "pack on  ${ON_T[*]} -> median $ON_MED s"
echo "pack off ${OFF_T[*]} -> median $OFF_MED s"

########################################################################
echo "== path system calls of one start (strace -f -c, on the runner natively; best effort)"
ON_SC=null; OFF_SC=null
count_syscalls() { # <pack value> -> prints the number of path syscalls, or nothing
  local sc=$WORK/strace-$1.txt out=$WORK/strace-$1.out
  reset_state
  sudo -n unshare -m sh -c "
    mount --bind /proc '$R/proc'; mount --bind /dev '$R/dev'
    exec strace -f -c -e trace=%file -o '$sc' chroot '$R' /usr/bin/env -i HOME=/root USER=root LOGNAME=root \
      PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/node/bin LANG=C.UTF-8 TERM=dumb TMPDIR=/tmp \
      DSH_RUNTIME_MODULE_PACK=$1 /bin/bash -c 'umask 022; mkdir -p /root/work && cd /root/work && exec dsh web --no-open --port $PORT'
  " > "$out" 2>&1 &
  local pid=$!
  for _ in $(seq 1 600); do grep -q "dsh web: http://127.0.0.1:$PORT/?token=" "$out" 2>/dev/null && break; sleep 0.1; done
  sleep 0.5
  sudo -n pkill -TERM -f "bin.js web --no-open --port $PORT" || true
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  sudo -n pkill -KILL -f "bin.js web --no-open --port $PORT" || true
  wait "$pid" 2>/dev/null || true
  sudo -n chown -R "$(id -u):$(id -g)" "$R/root" "$R/tmp" 2>/dev/null || true
  awk '$NF == "total" { print $4 }' "$sc" 2>/dev/null | head -1
}
if command -v strace >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  ON_SC=$(count_syscalls 1 || true); OFF_SC=$(count_syscalls 0 || true)
  [[ "$ON_SC" =~ ^[0-9]+$ ]] || ON_SC=null
  [[ "$OFF_SC" =~ ^[0-9]+$ ]] || OFF_SC=null
  echo "path syscalls: pack on $ON_SC, pack off $OFF_SC"
  [ -f "$WORK/strace-1.txt" ] && head -14 "$WORK/strace-1.txt"
else
  echo "strace or passwordless sudo is not available: syscall counts skipped"
fi
{ redact < "$LOG"; echo "--- stderr"; redact < "$ERR"; } > "$WORK/harness-redacted.log"
unset TOKEN

cat > "$RESULT" <<EOF
{"abi": "$ABI", "runner": "$(uname -m) $(nproc) CPUs", "extractSeconds": $EXTRACT,
 "firstStartToReadySeconds": $FIRST, "warmStartToReadySeconds": $ON_MED,
 "unauthenticatedStatus": $C1_ON, "tokenExchangeStatus": $C2_ON, "sessionListStatus": $C3_ON,
 "stop": "$STOP1", "osCpus": $CPUS, "l2sRmRetryNeeded": $RM_RETRY,
 "modulePack": {"buildId": "$BUILD_ID", "packOn": {"startSeconds": [$(IFS=,; echo "${ON_T[*]}")], "medianSeconds": $ON_MED, "pathSyscalls": $ON_SC},
  "packOff": {"startSeconds": [$(IFS=,; echo "${OFF_T[*]}")], "medianSeconds": $OFF_MED, "pathSyscalls": $OFF_SC},
  "callsCompared": $CALLS_N, "callsOk": $ON_OK, "responsesIdenticalOnVsOff": $EQUAL,
  "degradedCasesPassed": $DEGRADED, "outsideTreeModuleFromDisk": $OUTSIDE_OK},
 "shellPermissions": {"harnessStarts": $SHELL_STARTS, "scenariosPassed": $SHELL_SCENARIOS, "failClosedVariants": $SHELL_CLOSED,
  "catalog": $SHELL_CATALOG}}
EOF
cat "$RESULT"
