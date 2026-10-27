# OwnerTracker V11

**Current: single-shop review release 11.1.0-preview.5.** [Open the private review](https://azjetski-ownertracker-review.wholeclock.chatgpt.site) · [Job workspace and server preparation](docs/WORKSPACE_MILESTONE_2026-10-26.md) · [Compact project checkpoint](docs/PROJECT_STATE.md). The review uses fictional records and requires its managed runtime to remain active.

**October 26 assessment:** [Correctness findings, feature simplification and UI development plan](docs/PROJECT_ASSESSMENT_2026-10-26.md). The identified corrections are implemented in preview.2; preview.3 adds guided intake, job tabs and shared repair/counter accounts. Automated and browser results are recorded in the milestone. Real shop acceptance and permanent hosting remain pending.

One Windows POS/server with a shared SQLite database, desktop order receiver, owner and technician web clients, and native iOS source for AZ Jet Ski, Boats & Powersports.

The supplied **Complete Suite** and **Windows POS** ZIPs contain the same 80 files after removing the Complete Suite's outer `OwnerTracker-V11/` directory. This repository combines them without duplicating the server or databases. Original V11 installation, acceptance, release and long-term planning documents are retained. See [assembly provenance](docs/ASSEMBLY.md).

New desktop entry: `/desktop.html` provides Sales / POS, Calendar, Customers / Repairs and receipt/account shortcuts. Scheduling includes new-customer creation and directory search. See [tomorrow’s shop setup](docs/SHOP_DESKTOP_ROLLOUT.md). QuickBooks migration awaits the owner’s export; Google Calendar awaits OAuth setup and owner consent.

## Install on Windows

Follow [START_HERE.md](START_HERE.md), the authoritative V11 installation guide.

1. Install **Node.js 22.16 or newer within 22.x**, Windows x64.
2. Copy the entire `Windows-Server` folder to `C:\OwnerTracker`. Keep `OwnerTrackerDesktop.exe` beside `src`, `public`, `scripts`, and `windows`.
3. For a **new installation**, run `windows\SETUP_FIRST.cmd`. Store the generated password securely. Setup refuses to overwrite an existing `.env`.
4. Launch `OwnerTrackerDesktop.exe` and open `http://127.0.0.1:8787`.

For upgrades, first back up and restore-test the existing database **and photos**, preserve production `.env` and data, and follow the V11 guide. Do not run demo seeding on a production database.

| Client | Local URL |
| --- | --- |
| POS | `http://127.0.0.1:8787/` |
| Shop operations | `http://127.0.0.1:8787/shop-ops.html` |
| Owner mobile web | `http://127.0.0.1:8787/owner.html` |
| Technician mobile web | `http://127.0.0.1:8787/tech.html` |
| Billing | `http://127.0.0.1:8787/billing.html` |

Remote phones require authenticated HTTPS hosting; `127.0.0.1` on a phone refers to the phone itself. Keep server port 8787 private. Each client connects to the same shop server.

## Develop and verify

There are no third-party npm dependencies. With Node 22.x installed, from the repository root:

```sh
# New development installation only; generates private credentials.
npm run setup
npm start

# Static syntax checks and all supplied API regressions, including V11.
npm run check
npm test
```

`npm test` requires **Bash** (Linux, macOS, or Git Bash/WSL on Windows). It runs in a disposable copy with a clean environment, so local credentials, shop databases, uploads and backups are not used. Tests cover financial permissions and audit records, receipt rendering, damaged backups and restore rollback, plus V6/V8, V9, V10 and V11 repair POS, payments, billing, devices, custody, retail parts, inventory and scheduling. GitHub Actions runs the same checks on Node 22, tests the launcher, and provides a Windows x64 launcher build artifact.

`npm run desktop-agent` starts the manifest receiver when running the server without the Windows launcher. `npm run backup` creates a private full database/photo backup. Follow the V11 upgrade precautions and restore-test in a copied development installation first. With the server and desktop agent stopped, restore a full backup using:

```sh
cd Windows-Server
node scripts/restore-all.mjs PATH_TO_BACKUP
```

Use the backup directory containing `manifest.json` and `ownertracker.sqlite`. New backups include SHA-256 checksums for the database and complete photo set. Restore verifies them before making changes, replaces the photo set instead of mixing old files, and retains the previous database/photos in `data/ownertracker-before-restore-UUID` (beside a custom database path if configured). SQLite sidecars block restoration; stop both processes and do not manually delete a live database's sidecars. Original checksum-free V11 backups require the explicit `--allow-legacy` flag after checking their origin. Restart and verify customers, vehicles, work orders and photos. Protect `.env` separately; database/photo backups do not include credentials. Checksums detect corruption; store encrypted offsite copies for disaster recovery.

For the new permanent shop server, follow [SERVER_DEPLOYMENT.md](docs/SERVER_DEPLOYMENT.md). Its separate Compose configuration uses private generated credentials, persistent volumes, an unprivileged Node 22 application and Caddy HTTPS. A hosting account and domain are required; the review site is temporary. The earlier `deploy/docker-compose.yml` remains a local-only development alternative. The Windows desktop agent runs separately when needed.

The Go launcher source is `Windows-Server/windows/OwnerTrackerDesktop.go`. The rebuilt executable checks the Node version and private configuration, prevents duplicate startup, waits for server readiness, and stops both child processes on normal Ctrl+C shutdown. See [launcher instructions](Windows-Server/windows/README.md), including recovery after an interrupted shutdown. Windows hardware launch acceptance is still required. Native owner/tech iOS source lives under `Windows-Server/ios` with an XcodeGen `project.yml` (iOS 17+, Swift 5.9). Building/signing requires macOS, Xcode and an Apple developer configuration; signed apps are not included.

## Financial controls and receipts

The POS payment screen, billing screen and retail order details share refund/void controls. Only an owner or manager may record an externally completed refund, tied to its original payment with a reason and transaction reference. Refund amounts are capped by that original payment. Pending entries can be voided with a reason; confirmed funds require a refund. Payment retries preserve their key, altered retries conflict, and card/bank references cannot be reused across repair and retail ledgers. New entries retain the employee name/role at the time of the action in permanent audit events.

Use **Print account receipt** on these screens. Local repair receipts work without HTTPS and clearly say when no tax invoice has been issued. When an invoice exists, its historical figures are shown separately from the current account balance. Retail receipts require an issued invoice and preserve its customer/items snapshot. Pending or voided entries are not credited. These are printable browser views; physical Epson certification remains pending.

Historical employee roles are not reconstructed. A legacy refund without an original-payment link blocks further same-method refunds on that order until it is reconciled; existing history is preserved. New operational changes and remaining work are tracked in [development status](docs/DEVELOPMENT_STATUS.md).

## Release status

**Development/QA build; not production-certified.** Follow [QA_AND_ACCEPTANCE.md](QA_AND_ACCEPTANCE.md) and [LONG_TERM_IMPLEMENTATION_PLAN.md](LONG_TERM_IMPLEMENTATION_PLAN.md) before replacing a live POS. The long-term plan is preserved as a roadmap, not represented as completed work.

Live Google Calendar OAuth, Dejavoo/P1 charging, DocuSign, email delivery, Epson hardware and supplier purchasing require their own credentials and acceptance tests. Desktop order manifests do not place supplier orders. Keep `.env`, customer data, photos, tokens and backups out of GitHub; repository ignore rules protect the standard storage locations.

Assembly verification and remaining limitations are recorded in [docs/VALIDATION.md](docs/VALIDATION.md). Historical V6–V10 guides are retained for reference; use V11 documents for current instructions.
