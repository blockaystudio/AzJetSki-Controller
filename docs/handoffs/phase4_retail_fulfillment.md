# Supplier special-order quantity correction

The status-only supplier flow could release a quantity-two invoice after an unrelated generic quantity-one receipt, without an invoice-linked original stock sale. Fixed in `src/retail-fulfillment.mjs`, `src/inventory-movements.mjs`, `src/shop-ops.mjs`, plus the stock-key guard in `src/accounting.mjs`.

## API and physical stock semantics

- `POST /api/shop/retail-orders/:orderId/lines/:lineId/receive` accepts `{quantity, sku, supplierReference, idempotencyKey}`. The SKU must equal the retained invoice's `requested_sku || vendor_sku`; the route verifies the line belongs to that invoice. Owner, manager, advisor and parts roles may receive. An additive receipt uses a stable retry key instead of replacing an edit revision.
- One `BEGIN IMMEDIATE` transaction retains the partial receipt, a positive supplier receipt movement, an equal negative original-invoice sale/reservation, cumulative fulfillment status and audit. Reserved customer goods add zero to freely available stock. Pickup creates no second issue. Audit failure rolls everything back.
- Exact retries return the original receipt and movement IDs even after more receipts or pickup; changing invoice, line, SKU, quantity or reference with that key fails. Cumulative quantity cannot exceed the retained invoice quantity. Draft/cancelled invoices, completed/cancelled lines, and unconfirmed supplier orders cannot receive.
- GET retail lines include `fulfillment` with `sku`, `orderedQuantity`, `receivedQuantity`, `fulfilledQuantity`, `returnedQuantity`, `remainingQuantity`, `requiresReconciliation`, and a human-readable `reconciliationReason`. `receivedQuantity` counts new linked supplier receipts; `fulfilledQuantity` counts exact invoice-linked stock allocations, including legitimate on-hand issues.
- Partial receiving sets `partially_received`; full allocation sets `received`. Legacy `status: received` returns an actionable 409 directing clients to the quantity endpoint. Pickup requires the entire selected line fulfilled plus zero account due/refund due. Other order lines can remain open. Queues exclude legacy/unreconciled status-only readiness.
- Existing on-hand issue flows remain supported for supplier and non-supplier invoice lines. Original allocations remain consumed after customer returns, so a return cannot permit a second issue or pickup. Returns before initial pickup place a reconciliation hold with the actual reason; partial release after a return requires a separately reviewed plan.
- Supplier receipt sale IDs appear in existing scoped Accounting `stockSales`; customer returns retain original invoice/SKU/sale linkage and quantity caps. Damaged and resellable returns both reject stock-operation keys already used for receiving. Completed, allocated and previously manifested lines cannot re-enter supplier verification/cart purchasing.

## Upgrade and bounded limitations

The migration adds immutable `retail_supplier_receipts` history only. It does not infer quantities from old statuses, rewrite invoice snapshots, or add balancing stock for historical records. Legacy `received`/`picked_up` lines without exact retained invoice line IDs and matching original stock allocations are marked for reconciliation. Review original supplier packing slips, generic receiving, original sale records and customer custody before any further receipt/release. Do not re-enter an already received physical shipment to manufacture linkage.

Generic Management receiving remains a separate inventory workflow and does not fulfill an arbitrary retail order by SKU alone. An existing generic receipt with the same packing/allocation reference and SKU blocks duplicate dedicated receiving, and vice versa. For one supplier shipment/SKU split between customer invoices, use distinct documented allocation references (for example `PACK-42/INVOICE-A` and `PACK-42/INVOICE-B`). This is bounded per-invoice allocation receiving, not a consolidated PO allocation/reconciliation feature. Never record the same physical allocation in both workflows.

## Validation

Node 22.23.4, disposable in-memory fictional records only:

- `test/retail-fulfillment.test.mjs`: 10 passed: partial receipts, exact replay after pickup, full-payment/partial-stock hold, canonical SKU and account/line permissions, over-quantity rollback, duplicate generic/dedicated references and split allocations, legacy/cancelled/draft holds, scoped returns and pre-pickup hold, no repeat release, re-purchasing guards, atomic audit rollback, cancellation after receipt, existing on-hand fulfillment.
- Inventory movements: 8 passed; Accounting: 14 passed; Management: 10 passed. Changed-file syntax and `git diff --check` passed.
- Peer reviewers independently reproduced and verified the re-purchasing and pre-pickup-return guards. Browser reviewer reported the real UI partial receipt/lost-response retry/full payment/second receipt/pickup journey passing with exactly two received and two sold movements and unchanged available stock.
- Root owns runner/browser/full-suite integration and publication. Add `test/retail-fulfillment.test.mjs` to the runner. The existing V11 HTTP source contains no status-only receiving transition to update; its on-hand vendor allocation remains supported. No review runtime, real provider/customer data or commits used.
