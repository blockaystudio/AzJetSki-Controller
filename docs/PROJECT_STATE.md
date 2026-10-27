# OwnerTracker — compact project checkpoint

Updated 2026-10-27. Read this first; load only the relevant source or handoff.


## Browser failure investigation — 2026-10-27

Inspected main `cda0c6e` and its successful four-job CI run `40426309744`.
Four historical failures represent an already-corrected Ubuntu runner issue,
two counter-sale balance failures, and one unresolved repair-account refresh
timeout. Passing later runs did not change the implicated repair finance code.

Review branch `fix/ownertracker-browser-verification` corrects reproduced
counter-sale draft loss and stale stock callbacks, standalone Billing hash
overflow, weak browser completion waits and fixed-sleep HTTP startup. Finance
permissions, retained records and historical import behavior are preserved.
The original repair finance assertion remains intact; new failure traces and
network evidence support diagnosis if it recurs.

Local verification: 287 tests, 109 syntax checks, all V6/V8/V9/V10/V11 HTTP
regressions, 6 review-transport tests and the complete desktop/phone browser
journey passed. All 86 runtime hashes and 3 browser-test hashes match the reviewed
source. Platform conclusions are recorded in the branch's exact-SHA GitHub
checks. The existing preview5 ZIP still matches its original `f3d29ff` source;
it has not been replaced by this investigation.

See [status](../status.md), [bounded handoff](handoffs/browser_failure_investigation.md)
and [evidence](evidence/browser-investigation-2026-10-27.json).

Previous follow-up (application b7119ed): preview.4 adds desktop Sales/Calendar entry, scheduling customer creation/search, and private Google OAuth configuration helper. Owner explicitly asked to WAIT for the QuickBooks export, which they will add to Drive. Shared recovery chat is now read; its schema and archive features are incorporated in `/legacy.html` with a staff-only read-only adapter. Actual ZIP and active customer merging remain pending; no real records have been merged. Google OAuth client is not yet created; connection is not active. See `SHOP_DESKTOP_ROLLOUT.md` and `handoffs/desktop_calendar_legacy.md`. Local checks: 277 tests, 104 syntax checks and expanded browser journeys passed. Verified 114-file Windows package: `/workspace/OwnerTracker-Desktop-preview4.zip`; launcher rebuilt and review refreshed.

Preview.5 adds a transactional legacy-customer importer with original-ID links, collision detection and replay protection, plus customer-history links and counter-sale directory search. Private migration completion records stay outside GitHub. OAuth setup still requires the downloaded client JSON and owner consent. Tests:280/subtests,108syntax and isolated browser journeys passed.

## Goal and decisions

- One AZ Jet Ski shop; repairs and counter parts sales have equal priority.
- Source: https://github.com/blockaystudio/AzJetSki-Controller (main).
- Preview.2 completed assessment A01–A15 fixes and contrast/navigation foundation; see `CORRECTIONS_2026-10-26.md`.
- Preview.3 implements guided intake, six job tabs, shared repair/retail accounts, retained invoice documents, quantity-based special-order receiving, scoped refunds/returns and daily-close date guards. Milestone published and private review refreshed. Next: select/provision the permanent host and run shop acceptance.
- Owner explicitly needs a NEW server. Linux package is tested; hosting account and owned domain remain unanswered prerequisites. No cloud host, DNS or public certificate provisioned.
- Preserve customer isolation, approvals, financial/stock audit history and backups. Test only fictional disposable records. Automated charging/dealer checkout and signed native iOS remain optional/deferred.

## Read next

- Active [plan](DEVELOPMENT_PLAN.md); original [assessment](PROJECT_ASSESSMENT_2026-10-26.md); current [milestone](WORKSPACE_MILESTONE_2026-10-26.md); [server guide](SERVER_DEPLOYMENT.md).
- Relevant bounded handoffs: guided_intake, job_workspace, account_workspace, animator_phase3, phase3_documents, phase4_retail_fulfillment, phase3_browser, server_preparation under `handoffs/`. Do not load them all by default.
- App: `Windows-Server/src/server.mjs`; UI: `Windows-Server/public/`.
- Supported Node 22.16+ within 22.x. Current binary: `/home/agent/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node` (verify on resumption).

## Verification

- Preview.3 local: 273 application tests/subtests, 97 JS syntax checks, all V6/V8/V9/V10/V11 HTTP regressions and 6 bridge tests passed.
- Chromium: intake/recovery, job navigation/draft/race guards, invoice revisions, signed/revised approval, final repair payment/pickup retaining the second unit in custody, counter sale, partial supplier receipt/retry, payment/quantity pickup gates, stock return/original-payment refund and combined close. Final exact-source rerun passed; all 75 copied application file hashes matched current source, with 70 screenshots.
- 390/768/1440 layouts, reduced motion, keyboard and selected contrast checks (8.01–15.17) pass. Durable evidence under `docs/evidence/`; browser handoff records full artifacts.
- Sol Ultra + independent financial review corrected premature release, missing stock linkage, completed-order repurchasing, pre-pickup return ambiguity and cross-operation stock key reuse.
- Disposable Docker: non-root/read-only app, private port, Caddy, SQLite/photo restart persistence, encrypted backup/restore and recovery copy passed. Repeatable `test/server-deployment-smoke.py` now runs in CI. Public TLS/host reboot/offsite recovery remain host acceptance.

## Runtime and upgrade

- Review: https://azjetski-ownertracker-review.wholeclock.chatgpt.site
- Runtime: `/workspace/ownertracker-review-runtime/Windows-Server`; preserve .env/data/photos/settings. Updated to preview.3 and verified over HTTPS; all 74 source files match the published app. Twelve existing business table counts are unchanged. Pre-update backup: `backups/ownertracker-CVxAnt`.
- Bridge instructions and registered Site ID: `review-hosting/README.md`, `review-hosting/.openai/hosting.json`. Credentials stay in session/runtime storage. Review requires the workspace server.
- Legacy status-only fulfillment and physical returns before pickup require reconciliation; do not invent receipts or repeat supplier purchases. Split packing-document/SKU allocations require distinct documented references. Generic stock receiving does not automatically fulfill special orders.
- Published application commit: `0d3dbad268dc99e3535f02ce84d3164dd9a11c5a`. [App/browser/Linux recovery/launcher CI](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40402146084) and [Windows install/rollback](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40402146116) passed. Later documentation-only commits do not change this application.
- Portable outputs: `/workspace/OwnerTracker-preview3-release` (106 verified files), `/workspace/OwnerTracker-V11-preview3.zip`, and `/workspace/OwnerTracker-V11-preview3.git.bundle`. Source/runtime remain separate.
- Remaining shop gates: host/account/domain, staff accounts, reconciled starting data, offsite restore, actual Windows/phone/peripherals and selected live providers.

## Durable storage

GitHub is authoritative. Drive stores readable snapshots; it does not erase current chat history. No credentials, customer records or backups in these files.

- [Existing Drive folder](https://drive.google.com/drive/folders/1SMdizJKuDJaa7AXDfuCZGL0BBI5FJyUp).
- Plan `18u_4I4fxBZG9rjoqbAFDz2EkFHH7rVOE` ← `DEVELOPMENT_PLAN.md`.
- Checkpoint `1eMNo1v4-C64jhrADkXu6cg3b4p3_vfN1` ← this file.
- Milestone `1t5wwNc5E0i6EBPYjZ_-CwKXfVLFXk_qb` ← `WORKSPACE_MILESTONE_2026-10-26.md`.
- Update existing files after verified milestones; do not duplicate folders. Keep details in bounded handoffs.
