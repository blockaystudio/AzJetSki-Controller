# OwnerTracker — compact project checkpoint

Updated: 2026-10-26. Read this checkpoint first; load only the relevant source/tests or task section afterward.

## Goal and decisions

- One shop: AZ Jet Ski. Service repairs and counter parts sales have equal priority.
- GitHub: https://github.com/blockaystudio/AzJetSki-Controller (main).
- Current milestone: preview.2 implements assessment corrections A01–A15, contrast/mobile layout and restrained animation, equal repair/counter visibility and a tested stock counter-sale journey. Full job-workspace consolidation and real shop pilot remain future work.
- Preserve authorizations, financial/stock audit history, customer isolation and backups. Optional live merchant/dealer adapters and signed native iOS distribution remain deferred.
- Assessment baseline: e2e7e6f; earlier application baseline 81cd8a1. Before fixes: 145 application tests + 6 bridge tests passed, but extra checks found uncovered defects.
- Do not use real customer/provider data during tests. Review runtime and repository are separate.

## Completed work and focused handoffs

| Owner | Scope | Handoff |
| --- | --- | --- |
| repair_finance | A02/A09 atomic edits, consistent tax-inclusive totals; POS guard integration | handoffs/repair_finance.md |
| repair_identity | A01/A07/A10 customer/link identity, terminal stages, revision aliases, optional import isolation | handoffs/repair_identity.md |
| repair_stock | A03/A11 inventory retry/SKU linkage, custody completion timestamps | handoffs/repair_stock.md |
| repair_comms | A04/A06 SMTP failures, appointment reminder validity | handoffs/repair_comms.md |
| repair_invoices | A05/A13 selection races, invoice retries/revisions, old signature scope | handoffs/repair_invoices.md |
| animator | A08/A12/A14/A15 contrast, motion, mobile, truthful UI states, equal entry points | handoffs/animator.md |
| main developer | Integration, full/browser CI, review publication, GitHub and Drive checkpoint | this file |

## Entry points

- Full plan and acceptance criteria: [assessment](PROJECT_ASSESSMENT_2026-10-26.md). This remains historical evidence; current implementation status belongs here and in handoffs.
- App: `Windows-Server/src/server.mjs`; public UI: `Windows-Server/public/`.
- Isolated suite: `node Windows-Server/test/run-suite.mjs` with Node 22 (22.16+ within 22.x).
- Bridge tests: `node --test review-hosting/test/bridge.test.mjs`.
- Current environment Node 22: `/home/agent/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node` (verify existence on resumption).
- Review URL: https://azjetski-ownertracker-review.wholeclock.chatgpt.site
- Review runtime: `/workspace/ownertracker-review-runtime/Windows-Server`; fictional data only, preserve its database/settings on refresh.
- Hosting project ID and restart instructions: `review-hosting/.openai/hosting.json`, `review-hosting/README.md`. Credentials belong in runtime/session storage, never this checkpoint or Drive.

## Verification and remaining gates

- Final local checks: 213 application tests/subtests, 85 syntax files, legacy V6/V8/V9/V10/V11 HTTP regressions and 6 bridge tests passed.
- Browser: 9 routes at 390/768/1440, navigation/tabs, billing races, decimal amounts, reduced motion, contrast and counter sale through stock/split payment/pickup/receipt passed. See `docs/evidence/`.
- Independent Sol Ultra review: three extra integration defects fixed and reverified; `handoffs/corrections_review.md`.
- Upgrade: reissue legacy unbound status links; reconcile unattributed historical stock; imported financial data is protected from local edits; invoice callers require retry key/current revision.
- Published application commit: `080cc16`; CI compatibility follow-up: `bb739ac` (application source unchanged). [Application, browser and launcher CI](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40396656844) passed; [Windows install/rollback](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40396336668) passed.
- Private review updated and externally verified over HTTPS: login, new assets, staff APIs and reissued fictional customer link. Review data/settings preserved; pre-upgrade backup: runtime `backups/ownertracker-MgV6GR`.
- Portable outputs: `/workspace/OwnerTracker-preview2-release` (95 verified files), `/workspace/OwnerTracker-V11-preview2.zip`, `/workspace/OwnerTracker-V11-preview2.git.bundle`. Source/runtime remain separate.
- Next development: unified job workspace/intake, further shared operations and staff acceptance. Hardware, permanent hosting, actual provider delivery and real-data recovery require separate shop acceptance.

## Context storage

The requested Google Drive folder holds the plan and compact checkpoint snapshots. GitHub is authoritative for source and versioned status; Drive provides a readable planning copy. Storing notes does not erase current conversation history. Keep this checkpoint small, and record detailed work in bounded handoffs.

- [Drive project folder](https://drive.google.com/drive/folders/1SMdizJKuDJaa7AXDfuCZGL0BBI5FJyUp)
- Plan file ID: `18u_4I4fxBZG9rjoqbAFDz2EkFHH7rVOE`
- Progress file ID: `1eMNo1v4-C64jhrADkXu6cg3b4p3_vfN1`
- Milestone results file ID: `1t5wwNc5E0i6EBPYjZ_-CwKXfVLFXk_qb`
- Replace these existing file contents for future snapshots; do not create another project folder each turn.
