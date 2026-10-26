# Shop workspace milestone — 11.1.0-preview.3

This update brings repair intake, job work and account operations into the daily shop interface. Repairs and counter parts sales remain equally important. It also prepares a permanent Linux server installation; a hosted machine has not yet been provisioned.

## Implemented

- Guided repair intake selects or creates a customer and unit, records the complaint and estimate, assigns staff and optionally checks the unit into shop custody. A saved draft and explicit recovery after an uncertain save prevent blindly repeating a successful create request.
- The job workspace has Overview, Estimate & Approval, Work & Photos, Parts, Payments & Documents, and History tabs. Job context stays visible, links reopen the selected job/tab, and unsaved changes are guarded during navigation. Estimates and line items can be edited in context.
- Repairs, issued counter sales and Accounting share account controls for invoices, payment records, original-payment refunds, credits, cancellation, returns and the audit ledger. Actions stay bound to the selected account; overlapping saves are locked and unrelated drafts survive refresh.
- Staff can retrieve each issued invoice's original retained document, including superseded or cancelled versions. Later customer edits, payments and credits do not rewrite historical figures. Revised customer approval retains the prior signed scope and requires a new decision.
- Special orders now receive physical quantities against the exact invoice line. Each receipt atomically records incoming and customer-allocated stock, so reserved parts do not inflate available stock. Lost-response retries create one result; incomplete quantities or unsettled payments block pickup. Completed or previously manifested lines cannot be purchased again.
- The visual update preserves the shop palette, improves contrast and focus, adds responsive tabs and intake steps, and respects reduced motion. Long authorization fingerprints wrap on phones while retaining their complete contents.

## Verification

The integrated Node 22 suite passed **273 tests/subtests**, **97 JavaScript syntax checks**, all supplied V6/V8/V9/V10/V11 HTTP regressions, and six private review transport tests. Tests use isolated databases and fictional records.

Real Chromium acceptance passed guided intake, second-unit recovery after a lost response, all six job tabs, reload/back/forward, unsaved drafts, stale-job/account responses, invoices and revisions, held payments, signed and revised customer authorizations, and counter stock/split-tender/pickup/receipt. Seventy screenshots cover 390/768/1440px; measured contrast across the selected text, button, focus and status surfaces ranges from 8.01:1 to 15.17:1. See [browser handoff](handoffs/phase3_browser.md), [job workspace](evidence/job-workspace-desktop-preview3.png), [mobile approval](evidence/job-approval-mobile-preview3.png), [partial supplier receipt](evidence/special-order-partial-mobile-preview3.png) and [combined close](evidence/combined-daily-close-preview3.png).

The extended browser journey also passed pending-Zelle pickup blocking, payment confirmation, partial credit with tax, original-sale stock return, original-payment refund and a combined repair/counter daily close with zero discrepancies. Special-order acceptance passed reviewed supplier manifests, deposits, partial receipt, lost-response retry, paid-but-incomplete pickup blocking, final receipt and pickup with exact original-sale stock linkage. Repair acceptance extends through revised approval, final payment and pickup while the other unit remains checked in. Actual shop hardware remains unverified.

## Upgrade and reconciliation

Historical status-only special orders without exact invoice-line stock movements are flagged for reconciliation; the upgrade does not invent receipts or release quantities. Parts physically returned before pickup also require a reviewed release plan. Those records remain visible with an explicit explanation and cannot be released through the normal pickup action. Distinct documented allocation references are required when splitting a supplier packing document/SKU across customer invoices; generic inventory receipts are not automatically assigned to special orders.

## Server and shop rollout

The owner confirmed a new server is needed. The prepared installation uses Node 22, private configuration, persistent shop data and encrypted backups, automatic process restart, and a Caddy HTTPS proxy. See [server deployment](SERVER_DEPLOYMENT.md) for verified setup and recovery steps and the exact remaining provisioning requirements.

The disposable Docker run passed healthy startup, UID 1000/read-only operation, private application networking, Caddy reverse proxy, empty initial customer records, restart persistence, automatic encrypted backup and a database/attachment restore. Test resources were removed. [Container evidence](evidence/server-container-smoke-2026-10-26.txt) records the exact limits: local HTTP proxy verification does not prove public TLS or host reboot recovery.

A hosting account and shop domain are still needed. The private review uses fictional data and remains dependent on its managed workspace. Actual staff accounts, reconciled shop records, offsite recovery, phone/Windows/peripheral walkthroughs and any chosen live providers remain shop pilot gates. Optional automated merchant charging, dealer purchasing and signed native iOS distribution remain deferred.

Source and verified checkpoints live in [GitHub](https://github.com/blockaystudio/AzJetSki-Controller). Planning snapshots are kept in the existing [Drive project folder](https://drive.google.com/drive/folders/1SMdizJKuDJaa7AXDfuCZGL0BBI5FJyUp).
