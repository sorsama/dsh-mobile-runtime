#!/usr/bin/env bash
# Decides whether this run builds a release, and with which versions. Runs in the first
# job of the workflow, before anything expensive starts.
#
# Reads (env): GH_TOKEN, GITHUB_REPOSITORY, EVENT_NAME (schedule | workflow_dispatch),
#   HARNESS_INPUT (npm version or dist-tag, default latest), RELEASE_INPUT, MIN_APP_INPUT,
#   REBUILD, DRY_RUN, SIMULATE_FAILURE (none | early | late), AUTO_RELEASE (repository variable)
# Writes: step outputs to $GITHUB_OUTPUT and a short report to $GITHUB_STEP_SUMMARY.
#   build=false   nothing to do (the run ends quietly with every build job skipped)
#   build=true    harness_version, release_id, min_app_version, node_version, previous_tag, reason
# Exits non-zero only when a build was wanted but cannot be done (for example the harness
# needs a Node.js this runtime cannot ship); build=true is still written first, so the
# failure is reported like any other failed build.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${GITHUB_REPOSITORY:?}
EVENT=${EVENT_NAME:-workflow_dispatch}
REQ=${HARNESS_INPUT:-latest}; REQ=${REQ:-latest}
REBUILD=${REBUILD:-false}; DRY_RUN=${DRY_RUN:-false}; SIMULATE=${SIMULATE_FAILURE:-none}
OUT=${GITHUB_OUTPUT:-/dev/null}
SUM=${GITHUB_STEP_SUMMARY:-/dev/null}
TMP=${RUNNER_TEMP:-$(mktemp -d)}
out() { echo "$1=$2" >> "$OUT"; }
say() { echo "$*" | tee -a "$SUM"; }

case "${AUTO_RELEASE:-on}" in
  off|OFF|false|FALSE|0|disabled|no)
    if [ "$EVENT" = schedule ]; then
      out build false
      say "### Automatic releases are switched off"
      say "The repository variable \`RUNTIME_AUTO_RELEASE\` is \`$AUTO_RELEASE\`, so the scheduled check does nothing. Run the workflow by hand to build."
      exit 0
    fi ;;
esac

V=$(npm view "@deepseek-ai/dsh@$REQ" version --json | jq -r 'if type == "array" then .[-1] else . end')
[[ "$V" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]] || { echo "could not resolve '$REQ' (got '$V')"; exit 1; }
echo "npm: @deepseek-ai/dsh@$REQ is $V"

# Latest published release: its signed manifest says which harness it carries.
PREV_TAG=$(gh release list --repo "$REPO" --exclude-drafts --exclude-pre-releases --limit 1 --json tagName --jq '.[0].tagName // ""')
PREV_HARNESS=""; PREV_NODE=""; PREV_MIN_APP=""
if [ -n "$PREV_TAG" ]; then
  mkdir -p "$TMP/latest"
  gh release download "$PREV_TAG" --repo "$REPO" --pattern manifest.json --pattern manifest.json.sig --dir "$TMP/latest" --clobber
  "$HERE/verify-manifest.sh" "$TMP/latest/manifest.json" "$TMP/latest/manifest.json.sig"
  PREV_HARNESS=$(jq -r '.harness.version' "$TMP/latest/manifest.json")
  PREV_NODE=$(jq -r '.node.version' "$TMP/latest/manifest.json")
  PREV_MIN_APP=$(jq -r '.minAppVersion' "$TMP/latest/manifest.json")
  echo "latest release: $PREV_TAG (harness $PREV_HARNESS, node $PREV_NODE), signature verified"
fi

# Every published release, newest first: which harness version did each carry? The notes
# of every release (also the old ones) hold the row "DeepSeek Harness (`@deepseek-ai/dsh`) | <version> |".
gh api --paginate "repos/$REPO/releases?per_page=100" \
  --jq '.[] | select(.draft | not) | .tag_name + "\t" + ((.body // "") | gsub("\r?\n"; " "))' > "$TMP/releases.tsv"
EXISTING_TAG=""
while IFS=$'\t' read -r tag body; do
  ver=$(printf '%s' "$body" | sed -nE 's/.*DeepSeek Harness \(`@deepseek-ai\/dsh`\) \| ([^ |]+) \|.*/\1/p')
  if [ "$ver" = "$V" ]; then EXISTING_TAG=$tag; break; fi
done < "$TMP/releases.tsv"

if [ "$DRY_RUN" = true ]; then WANT=true; REASON="dry run: build and check everything, publish nothing"
elif [ "$REBUILD" = true ]; then WANT=true; REASON="rebuild requested by hand"
elif [ -n "$PREV_HARNESS" ] && [ "$V" = "$PREV_HARNESS" ]; then WANT=false; REASON="up to date: npm has $V and the latest release $PREV_TAG already carries it"
elif [ -n "$EXISTING_TAG" ]; then WANT=false
  REASON="npm has $V, which release $EXISTING_TAG already carries (the latest release is $PREV_TAG with $PREV_HARNESS). No second release is made for one harness version; tick rebuild to force one"
else WANT=true; REASON="npm has $V; the latest release${PREV_TAG:+ $PREV_TAG} carries ${PREV_HARNESS:-nothing}"
fi

if [ "$WANT" != true ]; then
  out build false
  say "### Nothing to do"
  say "$REASON."
  exit 0
fi

# Release id: UTC date plus the next free number of that day (2026.11.14-4). The number
# comes from the existing tags, so ids stay unique and sort by date, then by number.
if [ -n "${RELEASE_INPUT:-}" ]; then RID=$RELEASE_INPUT
else
  TODAY=$(date -u +%Y.%m.%d)
  LAST=$(gh release list --repo "$REPO" --limit 1000 --json tagName --jq '.[].tagName' \
    | awk -v p="$TODAY-" 'index($0, p) == 1 { n = substr($0, length(p) + 1); if (n ~ /^[0-9]+$/ && n + 0 > m) m = n + 0 } END { print m + 0 }')
  N=$((LAST + 1)); RID=$TODAY-$N
  while gh api "repos/$REPO/git/ref/tags/$RID" >/dev/null 2>&1; do N=$((N + 1)); RID=$TODAY-$N; done
fi
[[ "$RID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo "bad release id '$RID'"; exit 1; }
if [ "$DRY_RUN" != true ] && gh release view "$RID" --repo "$REPO" >/dev/null 2>&1; then echo "release $RID already exists"; exit 1; fi

MIN_APP=${MIN_APP_INPUT:-}; MIN_APP=${MIN_APP:-${PREV_MIN_APP:-0.22.0}}

# Node.js: does the bundled one meet what this harness asks for?
. "$HERE/versions.env"
ENGINES=$(npm view "@deepseek-ai/dsh@$V" engines.node 2>/dev/null || true)
CHOICE=$(node "$HERE/node-engine.mjs" choose "$ENGINES" "$NODE_VERSION" "$PREV_NODE")
NODE_OK=$(jq -r .ok <<<"$CHOICE")
NODE_USE=$(jq -r '.nodeVersion // ""' <<<"$CHOICE")

out build true
out harness_version "$V"
out release_id "$RID"
out min_app_version "$MIN_APP"
out node_version "$NODE_USE"
out previous_tag "$PREV_TAG"
out reason "$REASON"
{
  echo "### Build plan"
  echo "- harness: \`@deepseek-ai/dsh@$V\` (from \`$REQ\`), latest release carries \`${PREV_HARNESS:-none}\`"
  echo "- release id: \`$RID\`, previous release: \`${PREV_TAG:-none}\`, minimum app version: \`$MIN_APP\`"
  echo "- why: $REASON"
  echo "- harness asks for Node \`${ENGINES:-any}\`: $(jq -r '.note // .error' <<<"$CHOICE")"
  echo "- rebuild: $REBUILD, dry run: $DRY_RUN, simulated failure: $SIMULATE"
} >> "$SUM"

if [ "$NODE_OK" != true ]; then
  echo "::error title=Harness needs a Node.js this runtime cannot ship::$(jq -r .error <<<"$CHOICE")"
  exit 1
fi
if [ "$SIMULATE" = early ]; then
  echo "::error title=Simulated failure::simulate_failure=early: stopping before any build job, on purpose."
  exit 1
fi
echo "plan: build $V as $RID with Node $NODE_USE"
