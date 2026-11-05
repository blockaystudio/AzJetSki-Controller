# OwnerTracker — compact project checkpoint

Updated 2026-11-05. Read this first; load only the relevant source or bounded handoff. GitHub is authoritative.

## Goal and current application

- One AZ Jet Ski shop, with equal priority for repair service and counter parts sales.
- Repository: https://github.com/blockaystudio/AzJetSki-Controller (main).
- Preview.5 baseline: desktop Sales/Calendar shortcuts, scheduling customer creation/search, read-only recovered receipt archive, transactional customer importer and immutable original-ID history links.
- Preview.6 verified: proxy-aware Google OAuth/API transport, explicit local appointment save, and pagination through all historical customer/receipt results. 307 tests/subtests, 111 syntax files and the repair/retail/scheduling plus legacy-pagination browser checks passed.
- Owner-provided OAuth configuration is installed privately in review; owner Google consent remains pending. The hosting service changed the origin on publication; the owner must add the current callback in Google Cloud first (see SHOP_DESKTOP_ROLLOUT.md). Drive connection does not authorize Calendar. No credentials belong in source, handoffs or planning snapshots.
- Recovered customers and the historical archive are installed privately. Detailed reconciliation, source files and recovery identifiers stay outside GitHub. Active inventory/prices/opening balances still require reconciliation.

## Completed foundation

- Preview.2: assessment A01–A15 correctness fixes, contrast and navigation; see CORRECTIONS_2026-10-26.md.
- Preview.3: guided repair intake, six job tabs, shared repair/counter accounts, retained signed/revised approvals and invoice documents, scoped credits/refunds/returns, daily-close guards, quantity-based special-order receiving and pickup gates.
- Legacy status-only fulfillment and physical returns before pickup require reconciliation. Do not invent stock receipts, infer missing customer links or repeat supplier purchases.
- Permanent Linux package: generated private configuration, Node 22, non-root/read-only application, Caddy, persistent data/photos, encrypted backup/restore. Disposable Compose and Windows install/rollback CI passed. No permanent host, DNS or public certificate has been provisioned.

## Verification and working rules

- Preview.6: 307 application tests/subtests, 111 syntax files and V6/V8/V9/V10/V11 HTTP regressions passed. Full disposable shop browser journeys and the new archive paging browser check passed. Google public sign-in metadata returned HTTPS 200 through the proxy without credentials. See handoffs/calendar_history_preview6.md.
- Browser foundation covers repair intake through retained approval/payment/pickup, counter split tenders, partial supplier receiving/retry, payment/quantity gates, original-sale return/refund and combined close; 390/768/1440 widths and selected contrast checks passed.
- Use only disposable fictional databases for tests. Never mutate the imported review database or live providers as test fixtures.
- Supported Node 22.16+ within 22.x. Available binary: /home/agent/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node.
- Coordinate file ownership across agents. Keep handoffs concise under docs/handoffs/; do not repeatedly load old plans or conversation history.

## Runtime and delivery

- Owner-private review: https://azjetski-ownertracker-review.coastliquidators.chatgpt.site ; desktop /desktop.html ; Calendar /shop-ops.html?tab=schedule.
- Runtime is separate from source. Preserve private configuration, database, uploads, retained documents and backups on every update. The managed workspace must remain active.
- Review app uses a managed Docker container with a private loopback port. The Site bridge takes credentials through hidden stdin; restarting the container requires bridge reinjection. Review hosting is temporary, not the permanent shop server.
- Keep software releases free of real data/credentials. Install private data recovery separately; preserve original-ID mappings and the private archive path.

## Pending work and next gates

1. Completed: application d8b939b and release follow-up fc46c3e are published on main. Verified 118-file desktop ZIP: downloads/OwnerTracker-Desktop-preview6.zip. Private review HTTPS health returned200; existing business record counts match the pre-update backup.
2. Owner registers the current review callback in Google Cloud, then completes consent from Calendar; verify explicit sync with a fictional appointment after approval.
3. Select hosting account and owned domain, provision using SERVER_DEPLOYMENT.md and establish stable HTTPS/callback.
4. Reconcile active starting inventory/prices/balances, review migration exceptions and create named staff accounts.
5. Actual register/phone/printer/drawer/barcode walkthrough, bank/terminal reconciliation, restart persistence and encrypted offsite restore.

Manual terminal references and supplier ordering are supported initial workflows. Automated merchant charging, unattended purchasing and signed native iOS remain optional; do not mark owner/provider/device acceptance complete from automated tests.

## Read next

Active DEVELOPMENT_PLAN.md; SHOP_DESKTOP_ROLLOUT.md; SERVER_DEPLOYMENT.md. Relevant handoffs: legacy_import, desktop_calendar_legacy, account_workspace, phase4_retail_fulfillment, phase3_browser and server_preparation. Older handoffs describe their historical milestone; prefer this checkpoint and current source for status.

## Durable storage

GitHub is authoritative. Drive stores readable snapshots; it does not erase current chat history. No credentials, customer records or backups in these files.

- [Existing Drive folder](https://drive.google.com/drive/folders/1SMdizJKuDJaa7AXDfuCZGL0BBI5FJyUp).
- Plan `18u_4I4fxBZG9rjoqbAFDz2EkFHH7rVOE` ← `DEVELOPMENT_PLAN.md`.
- Checkpoint `1eMNo1v4-C64jhrADkXu6cg3b4p3_vfN1` ← this file.
- Milestone `1t5wwNc5E0i6EBPYjZ_-CwKXfVLFXk_qb` ← `WORKSPACE_MILESTONE_2026-10-26.md`.
- Update existing files after verified milestones; do not duplicate folders. Keep details in bounded handoffs.
