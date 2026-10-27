#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
export PORT=18990 HOST=127.0.0.1 OWNERTRACKER_DB="$(pwd)/data/v10-qa.sqlite"
export OWNERTRACKER_ADMIN_USER=owner OWNERTRACKER_ADMIN_PASSWORD='Test-Owner-Password-2395!'
export OWNERTRACKER_SESSION_SECRET='test-session-secret-v10-must-not-be-used-live'
export QBPOS_BRIDGE_TOKEN='test-bridge-v10-testing'
export DESKTOP_AGENT_TOKEN='test-agent-v10-testing'
export PUBLIC_BASE_URL='https://tracker.example.test'
export DOCUSIGN_ENABLE_SEND=false
unset SENDGRID_API_KEY SMTP_USER SMTP_APP_PASSWORD INVOICE_FROM_EMAIL EPSON_PRINTER_IP
rm -f "$OWNERTRACKER_DB" "$OWNERTRACKER_DB-shm" "$OWNERTRACKER_DB-wal"
node src/server.mjs > data/v10-test.log 2>&1 & PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT
node test/wait-for-server.mjs "$PID" "http://$HOST:$PORT/health" data/v10-test.log
node test/v10-address-devices.test.mjs
