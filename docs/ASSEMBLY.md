# Package assembly

Assembled October 24, 2026 from the two user-supplied V11 packages.

| Package | Files | Normalization |
| --- | --- | --- |
| `1-OwnerTracker-V11-Complete-Suite.zip` | 80 | Remove outer `OwnerTracker-V11/` directory |
| `2-OwnerTracker-V11-Windows-POS.zip` | 80 | Paths already start at repository root |

After normalization, every relative path and every file's contents match. There are no competing source versions or extra components to merge. The repository uses one copy of `Windows-Server`, so all POS, shop operations and mobile clients continue using the same authoritative database.

[`source-manifest.json`](source-manifest.json) records original ZIP SHA-256 hashes and the path, size and SHA-256 of each original file. It describes the inputs, before the assembly changes below.

## Assembly changes

- Added root README, npm command forwarding, assembly/validation records and GitHub Actions verification.
- Updated `Windows-Server/README.md` to point to the V11 instructions and describe one shared server.
- Updated `Windows-Server/package.json` to expose setup, syntax checks and the full regression suite.
- Added `Windows-Server/test/run-suite.mjs` to run the original database and V6/V8/V9/V10/V11 tests in disposable storage with no inherited live integration credentials.
- Added root Git exclusions for private settings, databases, photos, order manifests, backups and runtime files while retaining the package's placeholder instructions.
- Bound Docker Compose's published port to localhost and made its internal bind address, port and persisted database path explicit.

At the initial October 24 assembly, application source, original test cases, web assets, native iOS sources, Windows scripts, Go launcher source and supplied Windows executable were unchanged. Subsequent development updates payment controls, receipts, backup/restore, browser UI and launcher source/executable; see [development status](DEVELOPMENT_STATUS.md). The source manifest continues to identify the original input files, not current file hashes. Original V11 installation, QA, release and long-term planning documents remain available, including their duplicated copies under `Windows-Server`. Older V6–V10 material is historical reference. The runtime requirement remains **Node 22.16+ within 22.x**.

## Scope and remaining work

This assembly prepares the delivered development release for one GitHub repository. It does not claim completion of the long-term implementation plan's unchecked items. Live merchant and dealer integrations, Google OAuth, email delivery, legal/tax approval, HTTPS deployment, physical device testing and signed iOS distribution remain subject to the supplied acceptance gates.

No `.env`, test database, customer photo, live credentials or generated backup is part of this repository. No supplier purchase, payment charge, email or external calendar event was sent during assembly.
