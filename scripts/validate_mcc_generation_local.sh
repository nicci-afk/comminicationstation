#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ $# == 1 && -d "$1/candidate" && -d "$1/baseline" ]] || { echo 'Exact materialized bundles required' >&2;exit 2; }
export MCC_GENERATION_BUNDLES="$(cd "$1" && pwd)" MCC_FULL_FENCE=1
node --experimental-vm-modules --test --test-concurrency=1 "$ROOT"/tests/fixtures/mcc-generation/*.test.mjs
