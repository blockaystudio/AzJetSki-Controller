# Stock and official pickup corrections — A03 / A11

Implemented in `Windows-Server/src/inventory-movements.mjs`, `shop-ops.mjs`, and narrow integrations in `shop-management.mjs`, `accounting.mjs`, and `receipts.mjs`.

- All newly recorded inventory movements share `inventory_adjustments`, an immutable append-only ledger with unique idempotency keys, request fingerprints, exact invoice-line metadata, and supplier receiving-line metadata. Stock reductions cannot produce a negative balance. Existing historical rows remain untouched.
- The legacy `POST /api/shop/inventory-adjustments` receiving action now delegates to the existing supplier receiving operation. It requires a receiving line, validates its SKU, respects purchase-order quantity limits, and cannot create a second movement through the Management endpoint. Supplier document/SKU duplicates with a new key are rejected for reconciliation.
- Repair and retail stock sales validate the issued snapshot's exact line ID, SKU, and integer quantity. Cumulative repair issues follow the work-order line across invoice revisions. Superseded, voided and cancelled invoices cannot authorize new issues. Saved-key retries return the retained movement even after document state changes. Customer returns do not reopen the original invoice's sale allowance.
- Fully issuing an on-hand, no-vendor retail line changes it to `received`; when all lines are received the order enters `ready_for_pickup`. Existing payment/refund settlement rules protect release. Pickup does not deduct stock again.
- Official vehicle checkout checks current custody and settlement within `BEGIN IMMEDIATE`, and commits custody, `Picked Up`, `date_closed`, and audit together. Only Ready jobs may be released. Existing completion dates are retained, and historical missing dates are not fabricated.

## API contract

Every new inventory adjustment requires `idempotencyKey` (8–140 characters). Keep the same key and unchanged payload after an uncertain response. A changed payload under an existing key returns 409.

Sales:

```json
{"sku":"BELT-1","quantityDelta":-1,"reason":"sold","referenceType":"invoice","referenceId":"PART-2026-EXAMPLE","invoiceScope":"retail","invoiceLineId":123,"idempotencyKey":"stable-request-key"}
```

`GET /api/shop/inventory-invoice-lines?scope=retail&invoice=PART-2026-EXAMPLE` returns `{invoice, lines}`. Each line includes `id`, `sku`, `description`, `quantity`, `issuedQuantity`, `remainingQuantity`, and `requiresReconciliation`. Repair uses `scope=repair` and the same request shape.

Supplier receiving through the compatibility endpoint:

```json
{"sku":"BELT-1","quantityDelta":3,"reason":"received","referenceType":"supplier_order","referenceId":"PACKING-EXAMPLE","receivingLineId":456,"idempotencyKey":"stable-receipt-key"}
```

Management's existing receiving endpoint accepts the same key for the same operation and returns the same stock movement identity without adding stock. New compatibility endpoint responses use 201; exact retries use 200 with `duplicate:true`. Damage and cycle-count adjustments remain owner/manager-only with a documented reference. Customer returns remain in Accounting with original sale and credit note.

## Validation

- Eight in-memory regressions in `Windows-Server/test/inventory-movements.test.mjs`: cross-endpoint receipts, changed-key-payload conflicts, duplicate documents, unrelated invoice/SKU/line rejection, repair/retail quantity caps, negative-stock protection, revision allocation, retained customer returns, atomic rollback, counter-sale release, and report-visible completion timestamps.
- Passed focused test files: inventory movements, receipts, shop management, accounting, and shop reports using Node 22.23.4.
- Passed isolated V11 + hardening HTTP harness on port 18996 in a temporary copy with a sanitized environment, no live data or provider credentials. Updated `test/v11-shop-ops.test.mjs` to use documented receiving and exact invoice lines. The initial network-restricted sandbox blocked loopback; the successful run used the tool's additional network permission for the local harness.
- Root owns suite registration; add `test/inventory-movements.test.mjs` to `test/run-suite.mjs`.

## Limits

- Legacy invoice snapshots without retained line IDs, or historical sales without exact line attribution, require reconciliation before further stock issue. The implementation does not guess historical mappings or rewrite original movements. Repair may use the reviewed invoice revision workflow to capture current line IDs; existing movements still need reconciliation.
- Supplier reference + SKU must identify a unique physical receipt/return; ambiguous repeats are blocked rather than counted twice.
- No live supplier purchase, processor action, email, or hardware certification was performed. Physical opening counts and deployment review remain operational requirements.
