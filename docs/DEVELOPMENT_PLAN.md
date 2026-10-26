# Active shop development plan

Updated 2026-10-26. Scope: one AZ Jet Ski shop, with equal priority for repair service and counter parts sales. Use [PROJECT_STATE.md](PROJECT_STATE.md) for the latest verified commit and runtime details. The [original assessment](PROJECT_ASSESSMENT_2026-10-26.md) preserves findings and full acceptance criteria.

| Work | Status | Completion evidence / next gate |
| --- | --- | --- |
| Correctness foundation | Verified in preview.2 | Customer isolation, atomic finance, invoice retry/revision rules, stock linkage, custody, reminders and uncertain delivery; regressions and independent review |
| Shared navigation and visual foundation | Verified in preview.2; extended in preview.3 | Equal repair/counter entry points, contrast, mobile layout, keyboard focus and reduced motion |
| Guided repair intake and job workspace | Verified locally in preview.3 | New/existing customer, multiple units, check-in, six tabs, unsaved drafts, deep links, retained approval and documents |
| Shared repair/counter accounts | Verified locally in preview.3 | Invoice revisions, split tender, original-payment refunds, credits, returns, daily close; stale date and invoice-return selection guards fixed |
| Special-order fulfillment | Implemented; final integrated verification passed | Partial quantities, invoice-linked allocation, retry recovery, payment/quantity pickup gates and return history tested; legacy and pre-pickup returns require reconciliation |
| Permanent server preparation | Implemented; local container verification passed | Private generated configuration, Node 22, persistent SQLite/photos/backups, Caddy, restart and encrypted restore |
| Actual server provisioning | Needs hosting account and domain | Owner confirmed a new server is required; no provider/account/domain has been selected or provisioned |
| Shop pilot | Pending after permanent host | Staff accounts, reconciled starting records, offsite backup/restore, Windows and phone walkthroughs, selected peripherals/provider acceptance |

## Delivery order

1. Completed: preview.3 corrections published to GitHub and the private review site. Application, browser, Linux recovery, launcher and Windows install/rollback CI passed for `0d3dbad`.
2. Use the tested [server deployment guide](SERVER_DEPLOYMENT.md) to provision the selected host after account/domain details are available. Verify actual public HTTPS, external health, restart persistence and offsite restoration.
3. Run a fictional shop walkthrough on the actual devices, then a controlled real-record pilot with reconciled payments, stock, approvals and pickup. Expand only after those records balance.

Record only proven outcomes as complete. Manual terminal references and manual supplier ordering are valid initial workflows. Automated merchant charging, unattended dealer purchasing and signed native iOS distribution remain optional future work.

## Durable context

GitHub contains source, tests, this plan and bounded handoffs under `docs/handoffs/`. The existing [Drive folder](https://drive.google.com/drive/folders/1SMdizJKuDJaa7AXDfuCZGL0BBI5FJyUp) holds readable snapshots of this plan, the compact checkpoint and the latest milestone. Update those existing files; exclude credentials, customer data and backup archives.
