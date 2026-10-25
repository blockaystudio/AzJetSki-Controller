# Assembly validation

The latest single-shop review release adds the integrated launch-feature suites and deployed private review. See [SHOP_LAUNCH_REVIEW.md](SHOP_LAUNCH_REVIEW.md) and the current GitHub Actions run; earlier milestone results are retained below.

## Development update — October 25, 2026

- Full `npm test` on Node **22.23.4** passed: **56 focused tests/subtests**, original V6/V8/V9/V10/V11 API regressions, and a live local HTTP check of refund permissions, changed retry rejection, pending void exclusion, repair/retail print routes, no-store/authentication and the browser module.
- JavaScript syntax checks cover the application, browser modules and new tests. All test databases, photos, manifests and recovery bundles run in disposable storage.
- Windows launcher: **13 top-level Go tests** with additional cases passed under the race detector on Linux using Go **1.24.13**; Windows x64 cross-compilation succeeded. Official Go toolchain download SHA-256 was checked before use.
- Rebuilt `Windows-Server/OwnerTrackerDesktop.exe`: **6,461,952 bytes**, SHA-256 `5d9a77e128dd0916a659ea7f3b49d04c1184296c19a8c4a33cb482c25213927c`. The file is Windows x64 PE32+; this does not verify execution on a real Windows POS.
- Sol Ultra reviewed the shared financial controls and receipt/accounting distinction; no blocking finance defect remained after its recorder-preservation correction.
- GitHub Actions now runs Node regressions, launcher race tests, and a Windows build artifact. Remote results are recorded under **Actions**.

This update supersedes the initial assembly's unchanged-source/executable statements. See [DEVELOPMENT_STATUS.md](DEVELOPMENT_STATUS.md) for delivered behavior, migration limits and remaining work. Physical Windows/iPhone use, visual browser walkthroughs, signed iOS builds, live providers, HTTPS deployment, accountant approval and production certification remain unverified.

## Initial assembly — October 24, 2026

Date: October 24, 2026. Environment: Linux x64, Node.js **22.23.4**.

## Passed locally

- Compared both normalized input archives: **80 of 80 files identical**; input hashes recorded in `source-manifest.json`.
- `npm test` from the repository root: syntax checks for **32 JavaScript files**, **3 database unit tests**, and all supplied V6/V8/V9/V10/V11 API regression runners passed.
- Repair POS/customer/vehicle protections, roles, parts thresholds, duplicate command handling, payment/refund ledgers, invoice snapshots, DocuSign preparation, device-disabled behavior, custody/pickup rules, retail orders, stock controls and scheduling/ICS checks passed as covered by the supplied tests.
- Desktop receiver wrote and acknowledged a non-purchasing manifest. Full SQLite/photo backup and restored database checks passed in disposable QA storage.
- Regression artifacts were removed after completion; shop data and private `.env` were not used.
- Supplied desktop executable identified as a Windows x64 PE binary and preserved unchanged.
- Setup smoke test in disposable storage: strong credentials generated, localhost and non-purchasing defaults retained, and a second setup refused to overwrite existing settings.
- Verified private configuration/data exclusions, retention of all 80 supplied files, and local documentation links.

## Automated checks configured

`.github/workflows/verify.yml` runs syntax/API regressions on Node 22 and compiles the Go launcher for Windows x64. Actual remote workflow results are available under the repository's **Actions** tab; configuration alone is not a passing run.

## Not verified by this assembly

- Windows desktop execution, iPhone/Safari interaction, native iOS compilation/signing/distribution, and visual browser walkthroughs.
- Docker execution or deployment to a secure HTTPS domain.
- Live merchant charges/settlements, supplier purchases, Google OAuth/event creation, SMTP/SendGrid delivery, DocuSign submission, or Epson printing/drawer operation.
- Production data migration, concurrent front-desk use, tax/accounting certification, security penetration testing, or disaster recovery on real shop infrastructure.

The original October 8 acceptance report is retained in `QA_AND_ACCEPTANCE.md`; its historical results are not presented as newly executed hardware or browser checks. The release remains a **development/QA build**, with the original launch gates still applicable.
