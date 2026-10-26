# Independent correction review

Reviewed the uncommitted assessment fixes against `e2e7e6f`, concentrating on identity, retained finance, invoice/stock interactions, SMTP/reminders, idempotent retries and current-scope signatures. Review made no source edits and touched no review runtime or live providers. Reproductions used in-memory SQLite, fictional records and mocked signature HTTP responses; temporary signed-document files were removed.

## Confirmed findings and disposition

1. Historical repair invoices remained eligible for new stock issues after `superseded_by` was set. An old quantity-two invoice could issue two parts after its replacement reduced the quantity to one. Stock owner fixed this, retaining exact saved-key replay and cumulative line allocation across revisions; dedicated replacement-quantity regression passes.
2. A pending DocuSign completion could change an unchanged-scope job from `Declined` back to `In Progress`, because content scope omitted later native authorization decisions and stage was only screened for pickup/close. Invoice owner now requires the intended pending stage, binds latest native authorization state, and preserves signed evidence without applying stale scope. Dedicated decline/Ready/newer-native regressions pass.
3. POS financial line edits still recalculated imported jobs against the empty local payment ledger. Adding a $100 labor line to an imported $100 job with $50 already paid returned success and changed paid/due from $50/$50 to $0/$100. Finance owner added the same manual-account requirement already used by payments/invoices, covering all line mutations, financial fields on both PATCH aliases, and direct tax application. New regressions verify unchanged full-database snapshots on rejection while metadata edits remain available.

## Verification and limits

- Independently passed the current `inventory-movements`, `payment-docs`, `repair-line-finance`, `service-notifications` and `shop-mail` test files on the supported Node 22.
- Reran `inventory-movements`, `payment-docs` and `repair-line-finance` after all three review fixes; all pass. Reviewed their final guards and dedicated regressions. `git diff --check` passes.
- Six in-memory `job-policy` cases passed. Its two disposable HTTP cases hit sandbox `listen EPERM`; the main developer's full HTTP suite remains the integration gate.
- Exact invoice retries are intentionally excluded from the central body revision guard, then replayed before the invoice handler's revision check. A fresh issue still requires the reviewed revision. Main developer owns real HTTP replay verification.
- Invoice replay state retains the bearer link. Existing durable message bodies/links already retain customer bearer URLs; encrypting only the new cache with a rotatable session secret would not protect a database dump and could break durable replay. Treat cache, outbox and backups as sensitive shop data. A future no-redeemable-URLs-at-rest policy would require a dedicated stable storage key and all URL copies to be migrated together.

No additional high-impact defect was confirmed in the reviewed paths. This is focused source/fixture review, not live-provider or shop-device acceptance.
