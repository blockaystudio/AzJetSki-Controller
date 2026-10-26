# Correctness and interface milestone — 11.1.0-preview.2

Service repairs and counter parts sales remain equally important. This milestone implements the assessment corrections, a shared visual/navigation foundation, and an in-stock counter workflow. The broader unified job workspace and real shop pilot remain later development gates.

## Implemented changes

- **Customer isolation and job state (A01/A07/A10):** identity-bound customer links, transactional revocation, protected job identity history, revision checks on authorization aliases, and dedicated custody checkout for terminal job stages. Historical QuickBooks import defaults off and supports only an explicitly selected insert-only migration.
- **Repair accounts (A02/A09):** prospective tax-inclusive validation and atomic line/parts/totals/audit changes. Rejected edits leave no partial writes. Imported balances require reconciliation before financial edits.
- **Stock and completion (A03/A11):** retry-safe immutable stock movements tied to exact issued invoice lines/SKUs, supplier receiving records and original-sale returns. Issuance quantities span revised invoices; superseded invoices cannot authorize new issues. Pickup records completion timestamps transactionally.
- **Communications (A04/A06):** socket errors, timeouts and disconnects settle safely; ambiguous SMTP delivery is retained for review. Appointment reminders bind to appointment revisions and are cancelled/revalidated on schedule changes. Change notifications use the consent-aware outbox.
- **Billing and documents (A05/A13):** clearing/changing a selection immediately disables actions and stale responses cannot overwrite it. Invoice retries return the same result; changed payloads conflict. Revised invoices explicitly supersede retained originals without adding a second account debt. Late DocuSign results retain their evidence without overwriting newer scope or job decisions.
- **Daily UI (A08/A12/A14/A15):** six daily destinations, secondary setup menu, equal repair/counter entry points and queues, decimal money inputs, corrected empty lists, contextual stock/return/approval actions and accurate notification/provider outcomes.
- **Visual design and motion:** existing shop green retained with brighter text and clearer surface boundaries, visible focus, associated labels, mobile sizing and short 140–180 ms transitions. Reduced-motion preference disables animation and transitions.
- **Counter sales:** catalog/barcode lookup, on-hand display, invoice-backed stock issuance, split tender, paid pickup and receipt through the existing account ledger; no vehicle required.

## Verification

Final local integrated results: **213 application tests/subtests passed**, 85 JavaScript syntax checks passed, all included V6/V8/V9/V10/V11 regressions passed, and **6 private transport tests passed**. The browser suite passed all listed journeys. An independent Sol Ultra review found three additional integration gaps (superseded stock issues, late signatures and imported-balance edits); each was fixed and independently rechecked. See [PROJECT_STATE.md](PROJECT_STATE.md) and the relevant [task handoffs](handoffs/). Tests use disposable copies and fictional records, with no real provider transactions.

The durable browser suite `Windows-Server/test/browser-shop.py` covers nine routes at 390/768/1440px, Operations/Management tabs, equal entry points, decimal validation, focus, reduced motion, billing selection races, mobile empty states and a real local counter-sale journey through stock, split payment, pickup and receipt. GitHub CI now runs that browser suite against a disposable server.

Measured text contrast on the tested shared surfaces: 15.17:1 body text, 8.90:1 secondary text, 11.96:1 green action text. These checks do not constitute a complete accessibility certification. See [contrast measurements](evidence/ui-contrast-preview2.json), [phone screenshot](evidence/shop-today-mobile-preview2.png) and [desktop screenshot](evidence/shop-today-desktop-preview2.png).

## Upgrade behavior

- Legacy customer status links without identity binding are revoked rather than silently assigned to a possibly different customer. Staff must issue fresh links. Retained authorization and invoice records remain available.
- Old stock movements or invoice snapshots without attributable line IDs are not automatically mapped to new sales. Reconcile these historical records before issuing additional stock. New receiving requires a recorded purchase-order line.
- API callers issuing repair invoices must send a stable idempotency key and the expected work-order revision. A revised invoice must explicitly identify the current document it replaces.
- Financial corrections to imported jobs require a reviewed reconciliation process. Import cannot overwrite existing shop jobs or payments.
- Invoice replay responses and the messaging outbox can contain customer bearer links; treat the database, backups and exports as sensitive shop data. These contents do not belong in source control or planning storage.

## Remaining shop acceptance

Permanent hosting, real Windows/phone/peripheral checks, an encrypted restore drill, provider delivery/Calendar acceptance and reconciled shop records remain required for the selected production workflow. The private review still depends on its workspace server. Automated card charging, unattended dealer checkout and signed native iOS distribution remain deferred.

The development plan and a compact progress snapshot are also stored in the [Drive project folder](https://drive.google.com/drive/folders/1SMdizJKuDJaa7AXDfuCZGL0BBI5FJyUp). GitHub is authoritative for source and versioned results.
