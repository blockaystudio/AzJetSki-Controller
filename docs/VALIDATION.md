# Assembly validation

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
