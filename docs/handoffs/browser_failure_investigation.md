# Browser CI investigation and correction handoff

Updated 2026-10-27 (America/Phoenix). Baseline:
`cda0c6ec7f796f45ef68c153ecaa5bf3a0e87164`.
Branch: `fix/ownertracker-browser-verification`.

## Current conclusion

The latest baseline Verify OwnerTracker run, [40426309744](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40426309744), passed all four jobs. The preceding `f3d29ff` run also passed. Those green runs do not identify a fix for the historical repair finance-loading failure: its test and finance/workspace code are unchanged from `0333ff2`.

The investigation reproduced a counter-sale form replacement defect and its misleading browser-test completion checks. It also confirmed a standalone Billing phone overflow and a local HTTP harness startup race. Supported corrections are implemented on this branch. The original repair finance assertion remains intact; its exact historical cause remains unresolved.

## Historical failures

| Run | Commit | Failure | Attribution |
| --- | --- | --- | --- |
| [40396336965](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40396336965) | `080cc16` | Playwright install unsupported on Ubuntu 26.04; browser tests never ran | Already fixed by `bb739ac98f2ec2467885c471b67a74ae9488d856`, pinning browser CI to Ubuntu 24.04 |
| [40410580876](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40410580876) | `5ea257f` | Counter-sale `paymentTotals.due != 0` | Same symptom reproduced deterministically through the existing stock/form race |
| [40411589545](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40411589545) | `b7119ed` | Same counter-sale assertion | Repeated failure point; historical artifacts do not identify the missing tender or remaining amount |
| [40412001065](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40412001065) | `0333ff2` | Missing repair `[data-finance-panel]` after successful fictional cash POST | Captured DOM remains at the account loading placeholder; no established root cause |

The latest baseline run was 2026-10-27 00:25–00:27 UTC, or October 26, 5:25–5:27 p.m. Phoenix time. UTC commit/run dates explain the earlier October 27 references.

## Repair finance evidence and intended behavior

`browser_workspace.py::contextual_account` creates the marker `FICTIONAL-BROWSER-CASH` through a $25.50 cash payment on a newly created manual repair. It signs in as the fictional owner, checks the POST succeeded, verifies the ledger, checks a $75.00 remaining balance, and verifies an unrelated invoice draft survives.

`account-workspace.js` still renders the finance panel inside the repair account. Owner, manager, advisor and service writer can read the repair account. Refund/correction controls also require their existing narrower role and server authorization. Parts access is restricted to its permitted retail account; technician access and imported-account reconciliation restrictions remain intact.

The failed artifact has Payments & Documents selected on the correct job. `#jobAccountWorkspace` contains only `Loading payments and documents…`, with no account or finance panel anywhere in the DOM and no refresh error alert. This establishes that refresh had not completed at timeout; it does not establish a missing feature, changed selector, wrong role, or moved panel.

Two independent reproductions using the unmodified baseline passed: the complete workspace journey and a targeted experiment removing the payment route interceptor after the refresh GET started. Both runtime manifests matched all 86 baseline source files. The latter read completed with HTTP 200; no JavaScript errors occurred. No speculative repair finance application change was made.

## Implemented corrections

### Counter-sale account lifecycle and isolation

`public/shop-ops.js` preserves the same account container/controller when refreshing the same sale. The existing account component retains unfinished financial forms, while the outer invoice summary and fulfillment state refresh. A completed payment refreshes the outer view without remounting or redundantly refreshing the account. Account or tab changes still destroy the previous controller.

Request generation is separate from accepted-render generation. A failed outer read preserves existing financial drafts and working fulfillment controls. Late stock lookup and stock POST callbacks verify that their original view is still active before writing or reopening it, so a previous sale cannot replace the newly selected sale.

The controlled baseline reproduction held the stock response, entered $50.00 cash, and released the response. The form rebuild erased the amount. The old empty-field/enabled-button assertions passed with zero payment requests. The next $59.65 card payment then left $50.00 due and only one payment. A separate unfinished credit draft was also erased by a successful payment's outer refresh.

The corrected replay retains the $50.00 draft, records both tenders exactly once, reaches zero due, issues stock once, and retains the unrelated credit draft. Seven host/component regression cases cover retained drafts, successive callbacks, failed refresh, current-account isolation, leaving retail during payment, and delayed stock operations.

### Browser completion conditions and evidence

`test/browser-shop.py` and `test/browser_operations.py` wait for the successful stock POST and the exact line's fully issued/zero-remaining state. Each tender must produce its own successful payment POST; distinct references, expected intermediate balance, final zero due, two-payment count, ledger, stock, pickup and receipt checks remain required.

Every main shop journey now retains failure HTML, screenshot, traceback, Playwright trace, and timed request/response/failure records including pending requests. Artifacts include hashes of the three browser test modules as well as copied application source. This closes the historical counter-sale evidence gap and provides the missing request evidence if repair loading fails again.

### Standalone Billing phone layout

The retained authorization's full 64-character SHA-256 expanded a 390px page to 577px. Default fixture order could hide the problem by opening a different job. `public/ui-foundation.css` extends the existing history wrapping rule to `#billingAuthorizations .timeline-item`; no hash content is hidden.

All four seeded work orders passed at 390/768/1440px after correction (12 combinations). The main browser suite now explicitly selects retained-authorization fixture `REVIEW-1002` and checks it at every viewport.

### HTTP test server readiness

The baseline locally passed all 280 tests and 108 syntax checks, then the V6 HTTP suite failed with connection refused and an empty server log. Four shell harnesses assumed startup completed within 0.8–1 second.

`test/wait-for-server.mjs` replaces these fixed startup sleeps with bounded `/health` polling and process-liveness checks. It requires the expected OwnerTracker health response and prints startup log context on failure. Deterministic validation passed with 1.4-second delayed startup, early server exit, and an unhealthy endpoint that reaches the deadline. Business assertions are unchanged.

### Windows artifact completeness and readback

Application correction `745e86701ad78fdfce4b6111331ca341148bb596` passed all four Verify OwnerTracker jobs in [40565444211](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40565444211). The Windows installer job in [40565444105](https://github.com/blockaystudio/AzJetSki-Controller/actions/runs/40565444105) also passed, but it tested the release directory before artifact upload.

Downloaded artifact `12761004344` matched GitHub's SHA-256 digest and recorded the exact correction SHA. Its manifest listed 117 files; only 116 were present because upload-artifact omitted `.env.example`. The 116 present files matched the manifest and source (Windows CRLF differences normalized for source comparison). Both corrected application files were present. Running the real package verifier against the extracted artifact exited 1 with `Release file inventory or checksum mismatch`; the installer also requires the exact manifest inventory. This is a confirmed CI/packaging configuration defect, not a finance or customer-data failure.

`.github/workflows/windows-package.yml` now uploads hidden files from the private-data-free, allowlisted release folder and downloads that artifact to a distinct directory. Manifest verification and the existing Windows installation/rollback test run against the downloaded payload. The source package builder's private-data exclusions remain intact. A successful pre-upload test alone is no longer the release gate.

Failing artifact reproduction command (executed; exit 1):

```bash
/tmp/ownertracker-tools/node22/node_modules/node/bin/node Windows-Server/scripts/package-release.mjs --verify /tmp/ownertracker-ci-evidence/corrected-windows-package-40565444105
```

Consult the final branch's Windows run and PR for the workflow correction's exact tested SHA and replacement artifact. Do not install artifact `12761004344`.

## Validation

Integrated local verification passed: **287 tests, 109 JavaScript syntax checks, all V6/V8/V9/V10/V11 HTTP suites, and the complete desktop/phone browser journey**. All 86 copied runtime files and all three browser test hashes match the reviewed source. The browser run produced 73 screenshots, retained the original repair finance assertion, and completed supplier receiving, pickup, partial return/refund and combined close. Focused checks also passed: 24 account-workspace/host tests, the deterministic stock/payment/draft replay, all 12 Billing layout combinations, three readiness cases, and six review-transport tests. Exact-SHA Linux/Windows conclusions are attached to the correction branch Actions and PR checks; use those records for platform verification.

Local execution environment: Ubuntu 24.04.3, Node 22.23.4, Python 3.12.14, Playwright 1.56.0, Chromium 141.0.7390.37 (Playwright build 1194). All tests use source-only copies, disposable SQLite databases and fictional records. They do not load review-runtime data, live credentials, or real customer files.

Portable commands from repository root, with supported Node 22 on PATH:

```bash
npm run check
npm test
node --test review-hosting/test/bridge.test.mjs
python -m pip install playwright==1.56.0
python -m playwright install --with-deps chromium
OWNERTRACKER_NODE=node python Windows-Server/test/browser-shop.py
```

Actual local Node command: `/tmp/ownertracker-tools/node22/node_modules/node/bin/node Windows-Server/test/run-suite.mjs`. Actual browser command uses `PLAYWRIGHT_BROWSERS_PATH=/tmp/ownertracker-tools/browsers`, `OWNERTRACKER_NODE=/tmp/ownertracker-tools/node22/node_modules/node/bin/node`, `OWNERTRACKER_BROWSER_ARTIFACTS=/tmp/ownertracker-ci-evidence/corrected-browser` and `/tmp/ownertracker-tools/venv/bin/python Windows-Server/test/browser-shop.py`.

Linux Docker and native Windows install/rollback must be verified by their GitHub jobs; Docker and Go are not installed in this local environment. Responsive Chromium checks do not constitute physical iPhone or shop-peripheral acceptance.

## Package provenance

`downloads/OwnerTracker-Desktop-preview5.zip` declares source `f3d29ff` and version `11.1.0-preview.5`. All 117 manifest files match their sizes/hashes and the exact files at `f3d29ff5b0154b594b41fc86ee25c2260c5821ce`. ZIP SHA-256:

`947edc4cb35a31b258923df434e270f8fce0675d4c2223955f913cbf15e29c85`

That existing ZIP predates this branch's corrections. Source verification does not upgrade an installed package. The Windows verification workflow builds and tests a separate artifact from the correction commit. No deployed runtime or existing downloadable ZIP has been replaced by this investigation.

## Remaining repair-finance investigation / Codex handoff

The original selector failure is currently not reproduced, and its root cause is not claimed fixed. Preserve `FICTIONAL-BROWSER-CASH`, exact repair-account scoping, invoice draft retention, amount and permission assertions.

If it recurs, use the new `browser-network.json` pending list and `browser-trace.zip` to identify whether the work-order, accounting, payment, or invoice read stalled during `account-workspace.js::refresh`. Compare `source-manifest.json` and `test-source-manifest.json` to the exact failing SHA. Check lifecycle/current-generation guards and server response evidence before proposing a change. Validate any supported correction with the full isolated browser journey and regression suite; do not substitute sleeps, skipped assertions, or broader permissions.

Durable compact evidence: `docs/evidence/browser-investigation-2026-10-27.json`. Detailed local screenshots/traces are under `/tmp/ownertracker-ci-evidence` and may expire; historical run/artifact links above and committed findings are the durable references.
