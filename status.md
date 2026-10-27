# OwnerTracker failure investigation

Updated: 2026-10-27 (America/Phoenix). Review branch:
`fix/ownertracker-browser-verification`.

## Outcome

Supported corrections are implemented and locally verified. The latest inspected
main is `cda0c6ec7f796f45ef68c153ecaa5bf3a0e87164`; its Verify OwnerTracker run
[40426309744](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40426309744)
already passed all four jobs. The original repair finance-loading failure has not
reproduced and its exact historical cause remains unresolved. Its assertions are
preserved, with stronger failure diagnostics.

## Request checklist

- [x] Read repository instructions and project checkpoint.
- [x] Pin current main, inspect recent CI, and classify four failures into three failure points.
- [x] Review original logs, artifact HTML/screenshots, permissions and synthetic fixture flow.
- [x] Compare the original failing revision to current main; avoid attributing green runs to an unproven fix.
- [x] Reproduce counter-sale draft loss and the misleading payment completion checks.
- [x] Correct same-sale account retention, stale stock callbacks, Billing hash wrapping, test synchronization and HTTP startup readiness.
- [x] Preserve finance permissions, historical imports, desktop sales, scheduling and customer isolation.
- [x] Run the complete local regression and browser suites with fictional disposable data.
- [x] Prepare the reviewable branch, durable evidence and bounded handoff.
- [x] Verify the existing desktop ZIP's recorded source and all 117 manifest files.

Exact-SHA platform verification is recorded by the branch's **Verify OwnerTracker**
and **Verify Windows install and rollback** Actions/PR checks. Consult those run
conclusions for Linux Docker, Windows launcher and native Windows installation;
they are distinct from the completed local checks below.

## Changes

- Same counter-sale refreshes preserve the financial controller and unfinished
  payment/credit drafts; changing accounts still destroys the old controller.
- Late stock lookup/POST responses cannot write after a selection change or reopen
  the previous sale. Failed refreshes retain usable fulfillment controls.
- Browser tests require saved stock state and a successful POST for each tender,
  with exact intermediate/final balances and both ledger references.
- Standalone Billing wraps retained authorization hashes on phones. The browser
  suite explicitly tests the previously overflowing fixture at all three widths.
- HTTP harnesses poll actual health readiness instead of fixed startup sleeps.
- Browser failures retain HTML, screenshot, trace, timed network/pending requests,
  traceback and exact application/test source hashes.

## Completed verification

- Node 22.23.4 on Ubuntu 24.04.3: **287 tests passed; 109 syntax checks passed**.
- V6/V8/V9/V10/V11 disposable HTTP regressions: **passed**.
- Private review transport: **6 tests passed**.
- Complete Playwright 1.56.0 / Chromium 141 journey: **passed**, including the
  original repair cash ledger assertion, invoice drafts, revised approvals,
  selected-unit pickup, counter sales, partial receiving, payment gates,
  returns/refunds and combined close.
- All **86 runtime file hashes** and **3 browser test hashes** match the reviewed
  source; **73 screenshots** produced.
- Focused host/component regressions: **24 passed**, including 7 added cases.
- Deterministic stock-delay replay: $50.00 draft retained; both tenders recorded;
  two payments, zero due, one stock issue, unrelated credit draft retained.
- Billing: **12 job/viewport combinations passed** at 390/768/1440px.
- Readiness helper: delayed startup, early exit and unhealthy deadline cases passed.
- Python compilation, shell syntax and `git diff --check`: passed.

## Remaining investigation and package scope

The historical repair finance timeout remains unassigned to a root cause. Two
unmodified-source reproductions and the corrected complete browser journey passed.
Use the new request/trace evidence if it recurs; do not weaken the selector,
payment, draft-retention or permission assertions.

The existing `downloads/OwnerTracker-Desktop-preview5.zip` matches recorded source
`f3d29ff5b0154b594b41fc86ee25c2260c5821ce` and predates these corrections. GitHub's
Windows workflow builds a separate package for the correction commit. A passing
source test does not update the user's installed software. Physical shop devices
and peripherals remain shop acceptance, outside these isolated checks.

Full reasoning, commands and Codex continuation:
[docs/handoffs/browser_failure_investigation.md](docs/handoffs/browser_failure_investigation.md).
Compact evidence:
[docs/evidence/browser-investigation-2026-10-27.json](docs/evidence/browser-investigation-2026-10-27.json).

All validation uses fictional disposable data. No deployed runtime or real
customer database was modified.
