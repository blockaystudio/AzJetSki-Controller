# Purchasing command lifecycle

`ready_to_submit` → owner/parts worker checks every line → POST `/api/procurement/carts/:id/review` → creates `purchase_commands` immutable JSON+SHA256 → GET `/api/desktop-agent/commands` with `DESKTOP_AGENT_TOKEN` → local Windows outbox file → ACK `needs_connector`.

## Safeguards
- Must be authenticated owner, manager or parts user.
- Cart must meet minimum dollar threshold and have nonzero SKU/cost; total must match immutable review snapshot.
- Selected quantities must not exceed remaining unsupplied required quantities or available vendor stock.
- Every SKU/quantity/price must be explicitly confirmed in the review body; type `ORDER <vendor code>`.
- Demo SKUs and fake data are denied.
- Duplicate pending commands for the same cart are denied. Reviewed carts are locked out of re-consolidation; new requirements use a new cart.
- Agent writes `data/order-outbox/<command_uuid>.json` once, with a SHA256 match; file includes exact order manifest + work order and vehicle.
- Agent can **only** ACK `needs_connector` or `failed` (not `ordered`), until a tested server-side vendor connector with official order confirmation is implemented.
- No credentials or live orders are transmitted in V6.

## Future vendor adapter contract
Input `vendor, cartId, commandId, lines[{sku, qty, unitCost, workOrderId, vehicle}]`, immutable idempotency UUID, masked authentication token from Windows vault. Output signed/verified vendor order ID, accepted/declined line details, stock/price deltas, total including taxes/shipping, timestamp and acknowledgment. Requery supplier for price/availability immediately before order; if mismatch, require renewed owner authorization.

Never assert 'ordered' from an HTTP 200 response alone — verify unique supplier PO/order ID, accepted quantities, total, and retrieve order afterward. Keep purchase intent and actual supplier order as two separate data objects.
