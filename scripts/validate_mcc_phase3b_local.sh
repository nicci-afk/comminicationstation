#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# Tests require pinned dev-only PGlite + tsx in node's module lookup path.
node --import tsx tests/mcc_phase3b_workflow.test.ts
node --import tsx tests/mcc_queue_followup.test.ts
node tests/mcc_phase3b_database.test.mjs
node tests/mcc_phase3b_route.test.mjs
node tests/mcc_phase3b_ui.test.mjs
node tests/mcc_today_queue_ui.test.mjs
node tests/mcc_queue_followup_ui.test.mjs
node tests/mcc_today_queue_database.test.mjs
for test in tests/*static.test.mjs; do node "$test"; done
npm run build --prefix apps/web
git diff --check
