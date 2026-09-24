#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "== MCC v2 Phase 1.5 static guardrails =="
node tests/mcc_v2_phase1_5_static.test.mjs
node tests/mcc_safety_layer_static.test.mjs
node tests/supabase_security_hardening_static.test.mjs
node tests/mcc_phase2_current_obligations_2_static.test.mjs

echo
echo "== MCC v2 Phase 1 database regression =="
bash scripts/validate_mcc_v2_phase1_local.sh

echo
echo "== MCC Phase 2 seed integration validation =="
bash scripts/validate_mcc_phase2_seed_local.sh

echo
echo "== Web TypeScript + production build =="
cd apps/web
npm ci
npm run build

echo
echo "PASS: MCC v2 Phase 1.5 local validation completed successfully."
echo "No production deployment is performed by this script."
