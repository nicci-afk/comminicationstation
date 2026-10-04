#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --import tsx --test tests/reply-evidence.test.mjs tests/reply-integration.test.mjs tests/reply-handlers.test.mjs
node --import tsx tests/reply-review-ui.test.mjs
node tests/reply-source-body.test.mjs
node tests/check-reply-types.mjs
node --check tests/reply-native-concurrency.test.mjs
npm run build --prefix apps/web
# Native concurrency suite is intentionally excluded: requires a fresh isolated PostgreSQL server.
