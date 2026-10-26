# A05 / A13 invoice and billing repairs

Implemented in `Windows-Server/src/payment-docs.mjs`, `public/billing.js`, `public/billing.html`, `public/edit-revisions-ui.js`, and the purchasing snapshot check in `src/purchase-policy.mjs`.

- Billing clears the selected job, amounts, history, PDF link and authorization forms synchronously on selection/refresh. Every mutation validates the loaded selection. Generation checks discard late account responses; authorization forms are prepared detached and attached only for the current selection. Busy actions retain their original job and ignore responses after selection changes.
- Both repair invoice aliases require a current `expectedRevision` (or matching If-Match) and an 8–100 character `idempotencyKey` (`idempotency_key` / `requestKey` accepted). A retained request fingerprint rejects changed payloads. Exact retry returns the same invoice/link, even after revision or balance changes, and never queues a second message. Creation, revision consumption, supersession and audit are transactional.
- First document is `documentKind: invoice`. Subsequent documents must explicitly use `documentKind: revised_invoice` plus latest `supersedesInvoiceId`. These are full account snapshots, not additive debts. Previous snapshots remain immutable/readable with historical labels. New payment requests and purchase backing require a current document. Latest snapshot items retain original line IDs/SKUs. New invoice creation bumps only the job revision, not charges.
- DocuSign preparation requires current revision. Completed PDFs are retained even when stale, but job authorization/stage applies only to the latest packet, matching current scope and native authorization decision, while the job remains Awaiting Approval. Late completion cannot override Declined/Ready/terminal stages or a newer native request/decision. Legacy packets lacking the scope binding remain history only.
- Parent/other agents integrated invoice supersession with accounting cancellation, stock issue quantities across document revisions, and customer portal labels. Identity agent owns the server revision matcher and the invoice preguard exemption needed for exact retries.

Validation on Node 22.23.4, disposable/in-memory data only:

- `node test/payment-docs.test.mjs`: 8 passing tests, including both aliases, strict mode despite legacy configuration, changed-payload conflict, concurrent retry, replacement/no extra debt, rollback, current/stale DocuSign and later native decisions.
- `node test/billing-ui.test.mjs`: 5 passing tests executing actual billing source, including deselection, late account/authorization responses, retry key/revision retention and payment serialization.
- `node test/purchase-policy.test.mjs`: 4 passing tests; current revised purchase backing and stale body revision behavior covered.
- Accounting and edit-revision tests passed; finance agent subsequently added/passed accounting cancellation revision coverage.
- Strict `shop-launch-api.test.mjs` passed over disposable local HTTP.
- V9 billing and V10 address/device scripts passed in a disposable source copy on isolated ports 19049/19050. Existing fixtures now provide reviewed revisions and invoice request keys; V10's second invoice explicitly replaces its predecessor.
- Changed JavaScript syntax and `git diff --check` passed. No live customer/provider calls or data changes.

Parent runner must include `test/payment-docs.test.mjs` and `test/billing-ui.test.mjs`; this agent did not edit `test/run-suite.mjs`.
