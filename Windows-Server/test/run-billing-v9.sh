#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
export PORT=18989 HOST=127.0.0.1 OWNERTRACKER_DB="$(pwd)/data/billing-v9-qa.sqlite"
export OWNERTRACKER_ADMIN_USER=owner OWNERTRACKER_ADMIN_PASSWORD='Test-Owner-Password-2395!'
export OWNERTRACKER_SESSION_SECRET='test-session-secret-must-not-be-used-live-qa-x1'
export QBPOS_BRIDGE_TOKEN='test-bridge-x1-testing'
export DESKTOP_AGENT_TOKEN='test-agent-x1-testing'
export PUBLIC_BASE_URL='https://tracker.example.test'
export DOCUSIGN_ENABLE_SEND=false
rm -f "$OWNERTRACKER_DB" "$OWNERTRACKER_DB-shm" "$OWNERTRACKER_DB-wal"
node src/server.mjs > data/v9-billing-test.log 2>&1 & PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
node test/wait-for-server.mjs "$PID" "http://$HOST:$PORT/health" data/v9-billing-test.log
node test/billing-v9.test.mjs
