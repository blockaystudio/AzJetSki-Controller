# OwnerTracker V11

One Windows POS/server with a shared SQLite database, desktop order receiver, owner and technician web clients, and native iOS source for AZ Jet Ski, Boats & Powersports.

The supplied **Complete Suite** and **Windows POS** ZIPs contain the same 80 files after removing the Complete Suite's outer `OwnerTracker-V11/` directory. This repository combines them without duplicating the server or databases. Original V11 installation, acceptance, release and long-term planning documents are retained. See [assembly provenance](docs/ASSEMBLY.md).

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

`npm test` requires **Bash** (Linux, macOS, or Git Bash/WSL on Windows). It runs in a disposable copy with a clean environment, so local credentials, shop databases, uploads and backups are not used. V6/V8, V9, V10 and V11 tests cover repair POS, payments, billing, addresses/devices, custody, retail parts, inventory, permissions and scheduling, including backup/restore and the non-purchasing desktop manifest. GitHub Actions runs the same checks on Node 22.

`npm run desktop-agent` starts the manifest receiver when running the server without the Windows launcher. `npm run backup` creates a private full database/photo backup. Follow the V11 upgrade precautions and restore-test in a copied development installation first. With the server and desktop agent stopped, restore a full backup using:

```sh
cd Windows-Server
node scripts/restore-all.mjs PATH_TO_BACKUP
```

Use the backup directory containing `manifest.json` and `ownertracker.sqlite`. Restart and verify customers, vehicles, work orders and photos. Protect `.env` separately; database/photo backups do not include credentials.

Optional Docker: generate `Windows-Server/.env` with setup, then run `docker compose -f Windows-Server/deploy/docker-compose.yml up --build -d`. Compose publishes to localhost and persists `Windows-Server/data`; it starts the server only. The desktop agent can run separately. Docker execution has not been certified by this assembly.

The original Go launcher source is `Windows-Server/windows/OwnerTrackerDesktop.go`. A separate CI job compiles it for Windows x64. The supplied executable is preserved; Windows hardware launch acceptance is still required. Native owner/tech iOS source lives under `Windows-Server/ios` with an XcodeGen `project.yml` (iOS 17+, Swift 5.9). Building/signing requires macOS, Xcode and an Apple developer configuration; signed apps are not included.

## Release status

**Development/QA build; not production-certified.** Follow [QA_AND_ACCEPTANCE.md](QA_AND_ACCEPTANCE.md) and [LONG_TERM_IMPLEMENTATION_PLAN.md](LONG_TERM_IMPLEMENTATION_PLAN.md) before replacing a live POS. The long-term plan is preserved as a roadmap, not represented as completed work.

Live Google Calendar OAuth, Dejavoo/P1 charging, DocuSign, email delivery, Epson hardware and supplier purchasing require their own credentials and acceptance tests. Desktop order manifests do not place supplier orders. Keep `.env`, customer data, photos, tokens and backups out of GitHub; repository ignore rules protect the standard storage locations.

Assembly verification and remaining limitations are recorded in [docs/VALIDATION.md](docs/VALIDATION.md). Historical V6–V10 guides are retained for reference; use V11 documents for current instructions.
