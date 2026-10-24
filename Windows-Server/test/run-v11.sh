#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PORT=18991 HOST=127.0.0.1 OWNERTRACKER_DB="$(pwd)/data/v11-qa.sqlite"
export OWNERTRACKER_ADMIN_USER=owner OWNERTRACKER_ADMIN_PASSWORD='Test-Owner-Password-2395!'
export OWNERTRACKER_SESSION_SECRET='v11-test-session-only-not-production'
export QBPOS_BRIDGE_TOKEN='test-v11-bridge' DESKTOP_AGENT_TOKEN='test-v11-desktop-agent'
export PUBLIC_BASE_URL='https://tracker.example.test'
export ALLOW_UNINVOICED_TEST_CARTS=false
mkdir -p data
rm -f "$OWNERTRACKER_DB" "$OWNERTRACKER_DB-wal" "$OWNERTRACKER_DB-shm"
node src/server.mjs > data/v11-test.log 2>&1 & PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
sleep 1
node test/v11-shop-ops.test.mjs
