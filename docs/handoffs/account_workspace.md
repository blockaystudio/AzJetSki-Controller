# Shared account workspace — phases 3 / 4

Implemented `Windows-Server/public/account-workspace.js` for repair and retail, with no top-level DOM side effects. `mountAccountWorkspace(container, {scope, id, user?, onChange?, onError?})` returns `{ready, refresh, destroy}`. Every mount owns immutable scope/id; replacement, destruction, detached forms and generation checks prevent old reads, writes or callbacks from acting on a new selection.

- Repair invoice issue/revision/history uses the same request helpers as standalone Billing (`invoice-ui.js`). Reviewed revisions remain pinned; exact retries reuse keys and changed payloads get new keys. Retained invoice documents use `/api/billing/invoices/:id/document` (phase3_documents owner); current receipts remain separate.
- Shared payment/refund/audit ledger reuses `finance-ui.js`. Optional lifecycle, permission and busy callbacks preserve existing callers. One financial action runs at a time; refresh cannot replace an unresolved payment form. Acknowledged actions clear before refresh. Other financial drafts survive refresh, emitting `workspace:restored`; saved forms emit `workspace:saved` before reset. `onChange` receives `{scope,id,result,hasDrafts}` after saving/refreshed rendering.
- Credit notes, cancellation, return records and original stock-sale selectors are embedded. Server rules remain authoritative. Cancellation excludes superseded invoices; credit/return/history records remain visible. No raw ID entry is required.
- Owner/manager corrections and refunds are gated both by session role and server flags; advisor/service writer can review/record ordinary funds. Parts can view permitted retail ledger only. Imported repair accounts show reconciliation protection; no local finance fetch/write controls. Cancelled retail hides payment entry and unavailable receipt URLs.
- Standalone Accounting now mounts this renderer; account/scope selections invalidate prior loads. Daily close stays intact. Standalone Billing preserves its original layout/IDs and its five regression tests while sharing strict invoice payload/retry helpers.

Validation: Node 22.23.4, fictional in-memory UI fixtures only. `node test/account-workspace-ui.test.mjs` **17 passed**, `node test/finance-ui.test.mjs` **7 passed**, `node test/billing-ui.test.mjs` **5 passed**. Covers overlapping scope/job loads, detached/previous forms, late saves, pinned invoice revisions, changed-payload retry keys, cross-form serialization, retained unsaved drafts, role gates, imported accounts, cancellation/history and actual payment/credit payloads. Changed JS syntax and `git diff --check` pass.

Browser owner verified the real held-payment flow: invoice/refresh are disabled while the POST is pending; a separate invoice-email draft survives a saved payment; the host tab guard still detects that restored draft. Invoice/revision/payment journeys passed; final cross-screen results belong to `phase3_browser.md`.

Root registered `test/account-workspace-ui.test.mjs` in the suite. Browser agent owns integrated repair invoice/revision/payment, retail and viewport checks. Job agent owns the host unsaved guard's `workspace:restored` listener. No commits, backend edits, provider activity or review-data mutations by this agent.

## Phase 4 exception review

Reviewed actual credit/refund/physical-return/combined-close paths. Existing server caps preserve account subtotal/tax, original payment/method and remaining refundable amount, original invoice/stock-sale linkage and unreturned quantity; partial refunds reduce a credit balance without releasing custody early. Daily close combines repair and retail by Phoenix recording/bank-confirmation date, excludes pending/voided entries, nets refunds and retains every close revision. Focused disposable database tests reconfirmed **14 accounting + 9 finance-control tests passing**.

Fixed two operator-context gaps: changing Business date now immediately removes the prior close form/export, and both date plus load generation guard stale submissions/responses; the loaded date is explicitly displayed with the combined repair/counter basis. Original stock-sale return choices now follow the selected credit invoice, omit fully returned sales and show remaining quantities. These remain UI constraints; backend checks continue to authorize every change.

The browser owner subsequently passed the real pending-bank-confirmation/pickup/partial-credit/original-stock-return/original-payment-refund/combined-close journey, with exact method totals and zero retained-close differences. Special-order browser evidence belongs to that owner's final handoff. Real-shop processor/bank/drawer reconciliation remains acceptance work. The application records externally verified funds; it does not execute refunds or calculate recognized tax liability.

## Independent special-order review

Reviewed phase3_documents' new retained supplier-receipt ledger, atomic positive receipt/equal invoice-linked sale, quantity-based pickup, purchasing re-entry guards and additive legacy handling. Found two actionable edges; backend owner fixed both and added regressions:

- Returning reserved parts before pickup previously left the original full quantity releasable. A disposable reproduction now receives two, credits/returns one and settles the reduced account: pickup returns 409, one unit is on hand, and the exact reconciliation reason is exposed. Original allocation caps remain intact, preventing a replacement sale or fabricated receipt.
- A damaged customer return could reuse a supplier receipt's base operation key because it creates no stock movement. Return handling now checks the new supplier-receipt ledger and other stock-operation keys before either disposition, while exact return replay remains valid.

Independently ran **10 retail-fulfillment + 8 inventory-movement + 14 accounting tests passing** against the candidate. No other actionable financial/stock defect found in reviewed paths. Verified limit: legacy status-only fulfillment and pre-pickup physical returns require manager reconciliation; no unsupported release quantities are guessed. UI owner received the exact-reason and existing-stock-allocation display notes. No backend edits by this reviewer.
