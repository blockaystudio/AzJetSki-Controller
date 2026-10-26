# UI workspace handoff — phase 3

- Shared styles retain the existing colors, 44px controls, visible focus, restrained existing motion, and reduced-motion override. Job context sticks on desktop; at 768/390 it uses normal flow while tabs stick, leaving the editor usable. Tabs scroll horizontally without document overflow.
- Intake has numbered current/completed steps, readable customer and vehicle choices, selection/review summaries, recovery notices and wrapping actions. Staff find intake in More & Settings; six primary destinations remain. The job owner changed Today’s repair CTA to `/intake.html`; the equal counter CTA remains.
- Shared account panels provide consistent financial totals, invoice/payment columns on wide screens, stacked mobile forms, retained documents, credits/returns and keyboard-accessible scroll regions.
- `shop-ops.js` now mounts `account-workspace.js` for issued counter invoices. The duplicate retail payment form/history was removed; draft issue, part entry, stock issue, supplier status and pickup controls remain. Mount destruction and selection versions prevent late reads from replacing the selected order’s account.
- Coordinated actual markup with job/intake/account owners. The job owner added selected-tab visibility on resize; intake removes duplicate textual step numbers. No backend, review runtime, test/CI edits or commits in this scope.

## Verification

- Node 22 syntax checks passed for shared-ui.js and shop-ops.js.
- Disposable source-only server with fictional review data; isolated Chromium checked Today, intake/search/new customer, all six job tabs and the issued counter account at 390/768/1440. No document overflow or page errors. Arrow/Home tab operation and reduced motion checked.
- Actual computed contrast remains primary text **15.17:1**, muted text **8.90:1**, primary button **11.96:1**. Screenshots and responsive/contrast results: `/tmp/ownertracker-phase3-visual/`.
- Full intake, accounting and pickup behavior remains covered by the separately owned integration browser suite. This handoff records UI/layout evidence only.

## Populated authorization follow-up

The full browser journey found a 64-character retained snapshot hash expanding the 390px viewport to 535px. Scoped job timeline wrapping now keeps the entire hash/name/note visible within the card. Replayed the captured fictional populated page: reproduced 535px before, then 390/768/1440px exactly after, with all retained hash text unchanged. Evidence: `/tmp/ownertracker-phase3-visual/authorization-wrapping.json` and `authorization-populated-*.png`.

## Special-order receiving follow-up

`shop-ops.js` now displays per-line received/fulfilled/remaining quantities and a counted-quantity form with a packing/allocation reference. It posts the exact invoice SKU to `/api/shop/retail-orders/:orderId/lines/:lineId/receive` with a stable `postFinancialForm` retry key. Unknown/rejected saves retain the form and payload; acknowledged saves clear and disable it before reload. A failed detail reload provides a bounded refresh action rather than leaving an editable stale receipt form.

Manual supplier `ordered`/`shipped`/`backordered` controls remain; the generic `received` transition is gone. Pickup requires that line’s received status, zero remaining quantity, no reconciliation flag, and a settled account. Earlier ambiguous records show a reconciliation explanation. Role gating matches the fulfillment roles. Selected-order race guards and the shared account widget remain intact.

Node 22 syntax and diff checks passed. Fictional renderer checks passed at 390/768/1440, with partial pickup disabled, full paid pickup enabled, no generic received button, and no overflow. Screenshots and results: `/tmp/ownertracker-phase3-visual/retail-partial-receiving-*.png` and `retail-receiving-layout.json`. The separately owned real browser journey verifies server receipts, lost-response replay, invoice stock linkage, payment, pickup and returns after the backend change lands.
