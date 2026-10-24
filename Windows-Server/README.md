# Owner Tracker V11 Windows server

This folder contains the shared POS server, Windows desktop launcher, owner and technician web clients, and iOS source. See the [repository README](../README.md) for assembly details and validation.

For a new Windows installation, install Node.js **22.16+ within 22.x**, copy this entire folder to `C:\OwnerTracker`, run `windows\SETUP_FIRST.cmd`, and launch `OwnerTrackerDesktop.exe`. Keep the executable beside `src`, `public`, `scripts`, and `windows`. Setup creates private credentials; do not commit `.env`. For an upgrade, back up the existing database and photos, preserve `.env` and production data, and follow [START_HERE](../START_HERE.md).

Open `http://127.0.0.1:8787` for the POS, `/shop-ops.html` for shop operations, `/owner.html` for the owner client, `/tech.html` for the technician client, and `/billing.html` for billing. Mobile access requires authenticated HTTPS; keep port 8787 private.

For development, run commands from this folder: `node scripts/setup.mjs` once, then `npm start`. Run `npm test` for the regression suite. No third-party npm dependencies are required. The optional Compose setup in `deploy/docker-compose.yml` publishes only to localhost and uses the private `.env` created during setup.

See [the implementation plan](../LONG_TERM_IMPLEMENTATION_PLAN.md) and [acceptance requirements](../QA_AND_ACCEPTANCE.md) for live integration and hardware prerequisites.

Development/QA software, not production-certified.
