# Single-shop review release — 11.1.0-preview.1

This release is for AZ Jet Ski, Boats & Powersports. It does not add other shops, public registration, subscriptions, or multi-tenant billing.

The private review is **https://azjetski-ownertracker-review.wholeclock.chatgpt.site**. It runs the actual application and SQLite database through an authenticated review transport, using fictional records. It is not a static mock. Sign in with the review account shown on the sign-in screen; its credentials are for fictional data only. Use **Control Center** to examine every module and the sample customer journeys.

The review depends on this managed runtime remaining active. Its Worker and queue remain deployed, but closing/reclaiming the runtime stops the application behind it. Permanent shop hosting must use a continuously available Windows PC or Node/Docker host with persistent storage, real HTTPS and protected backups. The review database must never be copied into production.

## Requested feature coverage

| Feature | Implemented software | Shop configuration or acceptance still needed |
| --- | --- | --- |
| Retained authorizations | Immutable exact scope/amount/terms/customer/line/photo snapshots, typed consent and name, timestamp, PDF plus exact UTF-8 record and integrity hashes | Final shop wording and real-customer walkthrough |
| Additional-work approvals | Revised full-estimate requests, predecessor history, supersession/revocation, expiry, stale-scope rejection | Staff training on revised totals rather than additive amounts |
| Secure hosted access | Throttled password/PIN login, secure sessions/cookies, origin protection, credential-change session revocation, owner recovery | Permanent HTTPS domain/host and network testing |
| Private customer links | Expiring/revocable, single-work-order status or document scope; private-photo and cross-customer isolation | Real phone/customer testing |
| Concurrent editing | Monotonic revisions and original-form edit checks across customers, vehicles, work orders and lines; desktop/mobile/native request support | Two desk devices on the real shop network |
| Credits, cancellations and returns | Permanent credit notes and tax adjustments, unpaid cancellation, original-sale-linked physical returns, original-payment refunds and accurate credit/refund balances | Accountant review and real return/credit rehearsal |
| Daily close | Phoenix business dates, confirmed receipts/refunds, cash/card/Zelle comparisons, retained discrepancy/signoff, CSV | Match real drawer, bank and terminal settlement |
| Advisor/purchase controls | Per-job advisor, configurable ceilings, independent approval bound to exact vendor/cart/parts/quantities/prices | Assign real staff and approve policy thresholds |
| Customer communications | Separate service/marketing consent, durable event outbox, scheduled drafts, bounded retries, unknown-outcome review, marketing opt-out | Authorized sender/provider, delivery checks, automatic sending deliberately opt-in |
| Encrypted backups | Streaming AES-256-GCM full backup, authenticated restore staging, scheduled backup runs, retention and optional HTTPS offsite upload | Private key recovery copy, actual offsite destination, real restore drill |
| Windows releases | Hash manifests, private-data-free packages, staged installation and rollback, process/stopped-state checks, rebuilt launcher | Actual shop-PC update/restart and peripheral acceptance |
| Mobile/hardware | Owner/technician mobile web; native source with revision support; printable receipts and existing Epson adapter | Camera/Safari testing, exact Epson/drawer test, Apple signing for native distribution |
| Data migration/pilot | Reviewed customer import dry run/commit, duplicate checks, preserved backup/restore and release rollback | Reconcile real customers, vehicles, historical balances, authorizations and stock; controlled shop pilot |
| Google Calendar changes | OAuth adapter, conditional ETag-based edits/cancellations, retained conflicts and owner-reviewed resolution | Google Cloud credentials, owner grant and live API acceptance |
| Reporting/retention | Phoenix date-range cashflow, known-cost retail spread, aging jobs/pickups, advisor activity, recorded cycle times, consented follow-up drafts | Data-quality and accountant review; reports do not certify settlement or accounting profit |

Automatic merchant charging and unattended supplier purchases are **not implemented as live adapters**. The current Dejavoo flow records externally verified transactions, and supplier workflows produce reviewed non-purchasing manifests. Certified merchant/dealer documentation, credentials and sandbox access are required to complete those adapters safely. DocuSign signed-document code exists, but live app credentials and legal/provider acceptance remain necessary. Native iOS workflows compile unsigned simulator apps; this is not signed TestFlight or App Store distribution.

## Shop workflow review

1. Open the shop desk; inspect sample customers and multiple vehicles.
2. Open a work order and edit it from two sessions: the older form must show a conflict.
3. Request authorization, inspect the customer link, submit a fictional response, retrieve the retained PDF and exact record, then request a revised approval.
4. Open Billing/Payments, record fictional split tender, inspect pending Zelle exclusion, and view the account receipt.
5. Use Accounting for a credit/return and original-payment refund; verify due versus refund owed.
6. Use Management to request and independently approve an exact purchase, receive partial stock, inspect email drafts/consent, and change an appointment.
7. Open Reports and daily close; compare recorded cashflow with the sample ledger.
8. Use Control Center for recovery/session management, encrypted backup status and reviewed customer import.

## Deployment

For a local Windows installation, follow `START_HERE.md`, `Windows-Server/windows/README.md` and [verified releases](SHOP_INSTALLATION_AND_RELEASES.md). Generate private settings once; preserve them on upgrade. New setup generates a backup encryption key and enables local encrypted backup scheduling. Store an offline recovery copy of the key.

For an always-on Docker host, `Windows-Server/deploy/compose.https.yml` and `Caddyfile` supply an HTTPS reverse-proxy configuration. Set `SHOP_DOMAIN` and an `https://` `PUBLIC_BASE_URL` in the private environment, point DNS to the actual host, review its firewall, then use `docker compose --env-file Windows-Server/.env -f Windows-Server/deploy/compose.https.yml up --build -d` from the repository root. It persists database/documents and backups, keeps port 8787 internal, and restarts the services. Docker/live-domain operation has not been tested in this environment.

Set `BACKUP_OFFSITE_URL` and an optional token privately for a directory-style destination accepting encrypted HTTPS PUT uploads. Each upload gets a unique encrypted filename; a URL template containing `{filename}` is also supported. This does not provision remote storage. `NOTIFICATIONS_AUTO_SEND` stays false until consent, sender permissions and delivery are verified. Never enable live processing merely because a key is present.

## Evidence and limits

The integrated Node 22 suite includes retained authorization, security, revocation, concurrent editing, accounting, inventory, consent/outbox, Calendar mock APIs, encryption, packaging, reports, and a strict full HTTP workflow. Existing V6/V8/V9/V10/V11 regressions remain included. The review bridge has six independent Node 22 tests and deployed HTTP checks of the authenticated major screens. GitHub Actions checks Node, Go, Windows installation/rollback and unsigned iOS compilation.

No real customer approval, card charge, refund transfer, supplier purchase, customer email or external appointment was sent during development. Automated source/API checks and simulator builds do not replace visual, real-device, accounting or operational acceptance.
