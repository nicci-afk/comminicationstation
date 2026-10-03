#!/usr/bin/env bash
# Historical exact-source checks run against their original reviewed commit.
# Current guard behavior is checked separately against the new candidate.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE=f913bd8c208cce1fd4c42a3f14a5141d89d55ea0
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mcc-guard-snapshot.XXXXXX")"
ADDED=0
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  if [[ "$ADDED" == 1 ]]; then git -C "$ROOT" worktree remove --force "$WORK/snapshot"; fi
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
git -C "$ROOT" cat-file -e "$BASE^{commit}"
git -C "$ROOT" worktree add --detach "$WORK/snapshot" "$BASE"
ADDED=1
[[ "$(git -C "$WORK/snapshot" rev-parse HEAD)" == "$BASE" ]]
(cd "$WORK/snapshot" && node --experimental-vm-modules --test tests/mcc_agentedge_materializer.test.mjs)
echo "PASS: unchanged historical containment materializer checked at $BASE"
