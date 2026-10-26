# Phase 3 — retained invoice documents and safety review

Implemented `GET /api/billing/invoices/:id/document` in `Windows-Server/src/payment-docs.mjs`.

- Uses the same owner/manager/service-writer/advisor permission as repair invoice history. Staff sessions are required before lookup; technicians, parts staff, viewers and customer bearer links cannot read the document.
- Prints the selected immutable issued snapshot: retained recipient, email/phone, work-order reference/unit/revision, service and billing addresses, item quantities/SKUs/rates/taxability, tax, totals, credits, payments and balance at issue. It never reads current account lines, customer records or the payment ledger, and never recovers/reissues a public token.
- Superseded and cancelled invoices remain readable with prominent historical labels, including expired customer links. Missing legacy fields are identified as unavailable rather than replaced with current values; malformed snapshots fail closed. Print HTML escapes retained text, uses a script nonce/CSP and private no-store headers.
- Existing immutable snapshot triggers, issue retries, public invoice flow and account receipts remain intact. No records are migrated or changed by document GET.

Validation with Node 22.23.4, in-memory fictional fixtures only:

- `test/invoice-documents.test.mjs`: 7 passing tests covering real sessions and denied roles, token/header bypass attempts, old/revised identities and tax, cancelled/expired/stale documents, later credit/payment/refund drift, no GET mutations, escaped text, corrupt/legacy snapshots and methods/origin checks.
- `test/payment-docs.test.mjs`: 8 passed; `test/receipts.test.mjs`: 7 passed.
- Independently ran shared account UI (8), finance UI (7), accounting (14) and financial-control regressions; syntax and `git diff --check` passed.
- Parent owns `test/run-suite.mjs`; include `test/invoice-documents.test.mjs`. No commits, review-runtime changes or provider/customer data used.

Independent review: shared account mounts bind an immutable scope/ID, invalidate stale generations and detached forms, and guard late payment/confirmation/refund callbacks. Server checks retain credit scope/account, return credit/original-sale identity, refund original payment/account/method and quantity/amount limits. No wrong-account financial mutation path found. Flagged cancelled retail offering payment and unavailable receipt links; account-workspace owner corrected those controls and labels. Parent/browser reviewer owns browser evidence and remaining integrated UI acceptance.
