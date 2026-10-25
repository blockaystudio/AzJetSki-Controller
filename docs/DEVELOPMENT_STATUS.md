# Development status — October 25, 2026

This update advances the shared Windows POS/server and browser clients. The two original ZIPs are one application; the native iOS sources remain part of the same suite.

| Implementation-plan item | Development progress | Remaining acceptance |
| --- | --- | --- |
| 36: refund authorization and void reasons | Shared owner/manager refund and pending-payment void controls, required reason/source, immutable employee snapshots/events, transactional audit writes, exact retry checks and cross-ledger receipt protection | Shop policy walkthrough; broader invoice cancellation/void workflow is separate |
| 48: pickup and retail receipts | Authenticated browser-print account receipts with tax, payments, refunds, pending and remaining amounts; immutable invoice snapshots separated from current balances; local repair fallback | Physical Epson printing and customer/shop walkthrough |
| 29: full backup/restore safety | Checksummed database/photo manifest, integrity validation, no stale-photo overlay, retained complete prior state, failure rollback, explicit legacy handling | Restore a copied production dataset and verify on the actual Windows PC |
| 28: Windows installation | Rebuilt x64 launcher enforces Node/config, duplicate/port checks, server readiness, configured local port and child cleanup | Actual Windows launch, console-close and shop-device acceptance |

## Payment behavior and migration

- Ordinary service writers/advisors can still record verified payments. Only owner/manager can record refunds or void pending entries; these operations never send money.
- Refunds require the original confirmed payment ID, matching method/order, a reason, a refund reference and strict verified confirmation. Partial refunds are capped cumulatively by the original receipt.
- New pending entries are incoming Zelle only. Pending entries may be voided without deleting history. Once voided, they cannot be confirmed. Confirmed payments cannot be deleted or rewritten; an authorized refund records money returned externally.
- Exact retries return the original result. Changed payloads under the same key return HTTP 409, including after a pending entry is confirmed or voided. Cross-ledger repeated Dejavoo/Zelle references are blocked for the same transaction direction.
- Additive migrations retain old rows. Historical employee names/roles are left unknown where they were never recorded. Legacy refunds without an original-payment link conservatively block new refunds of that method on the order until reconciliation. There is no automated history rewrite or bypass switch.
- Retail invoice issuance and customer/item snapshot capture commit together. Older retail invoices disclose missing historical snapshot details instead of inventing them.

## Recovering data

`npm run backup` creates a full database/photo snapshot with hashes. Stop the server and desktop receiver before restoring. From `Windows-Server`, run `node scripts/restore-all.mjs PATH_TO_BACKUP`; verified original checksum-free backups additionally require `--allow-legacy`. A full prior-state recovery copy remains beside the database. Validation rejects corrupt/missing/unexpected files, linked paths and SQLite sidecars before the swap; a caught swap failure restores both original components. A power failure still requires recovery from a verified backup, so retain protected offsite copies. Manifests provide integrity checking, not encryption or proof of authenticity.

## Validation

The required Node 22 suite passes 56 focused tests/subtests, original V6/V8/V9/V10/V11 API regressions, and live local HTTP integration of financial controls and account receipts. Launcher tests and a Windows x64 cross-build verify its source on the build host. Detailed evidence is in [VALIDATION.md](VALIDATION.md); GitHub Actions supplies remote results.

Sol Ultra reviewed the financial architecture and implementation. Its review led to preserving the original retail recorder on bank confirmation and separating current account activity from historical invoice figures.

## Next work and dependencies

- Item 31: prevent stale writes from multiple desks with revision checks across **every** customer, vehicle, work-order and line writer. Payment transactions do not solve ordinary edit conflicts.
- Item 59: advisor responsibility and configurable purchasing ceilings; item 60: independent second approval for high-risk financial/stock/purchase actions. Current owner/manager authorization is a single-person control.
- Items 37–42: authenticated HTTPS host and Google Cloud app credentials/owner grant before live Calendar acceptance; rescheduling/cancellation propagation remains development work.
- Items 43–47 and 50–52: processor-approved Dejavoo access, DocuSign app credentials/legal wording, authorized email provider, Epson model/network, and documented dealer APIs/sandboxes before live integrations. No real purchase, refund transfer, charge, email or calendar event was sent in development.
- Native iOS builds require macOS/Xcode/signing, followed by real owner/technician iPhone camera/upload/permissions testing. This environment has not produced signed apps.
- The rest of the original long-term plan remains open. Financial accounting/tax approval, real inventory counts, encrypted offsite recovery, mobile/visual tests and production security certification remain launch gates.

This is still a development/QA release. Automated checks do not certify live financial operations or physical devices.
