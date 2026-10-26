# Repair finance handoff

Scope: A02/A09; POS integration of A01/A07 shared job policy. No commits or review-data mutations.

## Changes

- Repair line POST/PATCH/DELETE now validate complete prospective tax-inclusive cents, retained credit subtotal/tax allocations, net confirmed payments and refunds before writing. Pending/voided ledger entries do not count as paid.
- One transaction covers the line, linked part requirement, part/labor totals, tax/account totals, tax event, audit and record revisions. Error paths roll back all rows and allocated IDs.
- Fully paid $100 taxable/$109.10 total invoices permit description edits and zero-value add/delete. Invalid/nonfinite/negative line inputs reject with 400.
- POS creation/PATCH use `job-policy.mjs` stage guards. Identity reassignment uses the shared history guard and retains old/new identity in its transactional audit.
- Customer/unit directory edits preserve protected job identity snapshots; safe Intake snapshots and customer contact details still update. Audits list preserved job IDs. Submitting unchanged IDs does not rehydrate a protected snapshot from the current directory.
- Unitemized work-order amount PATCH validates credits/net payments before mutation and runs with its audit in a transaction.
- Follow-up A13 integration: cancellation rejects superseded repair invoices and counts only unsuperseded, nonvoid documents as active. Current revised invoices cancel the remaining account after historical credits; original invoice, credit and return references remain intact.
- Final review fix: imported jobs reject all POS line mutations and financial fields on both work-order PATCH aliases until reviewed migration reconciliation. Shared tax/balance recomputation also requires a manual account, preventing an empty local ledger from erasing imported payments. Metadata-only updates remain available and preserve original financial values.

## Verification

New suite: `Windows-Server/test/repair-line-finance.test.mjs` (14 tests). Add it to the explicit suite runner list.

Passed with `/home/agent/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`:

```
--test Windows-Server/test/repair-line-finance.test.mjs Windows-Server/test/accounting.test.mjs Windows-Server/test/finance-controls.test.mjs Windows-Server/test/edit-revisions.test.mjs Windows-Server/test/purchase-policy.test.mjs
```

Tests use only in-memory fictional fixtures. They cover the reported $100/$80-credit rejection, full-database unchanged snapshots on rejected edits/deletes/additions, tax-inclusive paid and credited invoices, refund/pending/void treatment, credit tax allocation, and injected audit/tax-history failures with successful retry after rollback.

Follow-up accounting suite: 14/14 passed after adding two cancellation regressions for revised versus historical invoices and unresolved duplicate active documents. The revised-invoice test verifies retained credit allocation, exact cancellation retry and a return against the original invoice after cancellation.

Final imported-account regressions: repair line tests, accounting and finance controls passed; job policy passed 8/8 including actual HTTP attempts through both amount PATCH aliases, line additions/edits/deletions, and safe metadata-only updates. The HTTP run used local-network permission after the sandbox's default localhost-listen denial; no provider/network service was contacted.

## Remaining integration

- Identity agent owns shared policy and dedicated identity/directory/stage route regressions.
- Root owns suite registration, full API/browser/release checks and deployment.
- No known unresolved A02/A09 defects from focused checks. Existing policy still requires refunds before a line edit would leave the effective total below net paid.
