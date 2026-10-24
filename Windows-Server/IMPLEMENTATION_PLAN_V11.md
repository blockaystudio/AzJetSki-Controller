# Owner Tracker — V11 implementation and long-term completion plan

**Business:** AZ Jet Ski, Boats & Powersports • Phoenix • 602-482-9322  
**Date:** October 8, 2026  
**Product intent:** one local Windows POS/server plus secure owner and technician mobile clients, connected to a single authoritative database. Historical QuickBooks imports remain deferred.  
**IMPORTANT:** V11 is a development/QA release, not a production-certified accounting/POS/merchant or dealer-ordering platform. All new API endpoints require authentication and enforce role permissions.

## 1. Delivered and integrated into V11 code (verified in automated API tests)

- [x] **1.** Split “Ready for Pickup (paid)” from “Payment Pending (ready but owing).” Do not release an unpaid unit through checkout.
- [x] **2.** Track physical **vehicle custody** independently from repair-stage status. Record check-in/check-out timestamps, key tag, lot/bay, employee and audit history.
- [x] **3.** List **customers currently checked in** by distinct customer and count the vehicles on property, rather than treating every open work order as an on-site customer.
- [x] **4.** Search **vehicles physically in the lot** by name, vehicle, VIN/HIN and parking location.
- [x] **5.** Connect a newly created work order to a vehicle that was already checked into the lot.
- [x] **6.** Reject check-ins that link someone else's vehicle to a work order or check in the same unit twice.
- [x] **7.** Separate employee role **Advisor** from technician, manager, owner, and parts; grant repair notes, progress, assignments, repair authorizations, parts, and reviewed purchasing; deny employee administration and owner-only stock restocking.
- [x] **8.** List repair purchasing items without either an issued customer invoice **or signed Approve Repairs authorization**; refuse to queue them by default. QA fixtures can explicitly enable legacy tests; production must not.
- [x] **9.** Create customer **retail/special-order parts** without inventing a vehicle or repair work order. Retain customer name/address, contact, tax rate and invoice number.
- [x] **10.** Enter item, requested SKU, exact supplier SKU, dealer cost, customer price, quantity, taxable status, and confirmed ETA where provided.
- [x] **11.** Lock retail invoice amounts and billing-address snapshot once issued; changes require a new supplemental order instead of silently rewriting the invoice.
- [x] **12.** Apply the shop's **9.1% requested tax setting** to taxable retail lines; keep historical rate snapshot and let the accountant verify the final tax classification.
- [x] **13.** Require a real issued retail invoice before any customer special-order item can be marked supplier-verified.
- [x] **14.** Build **supplier-specific consolidated retail carts** from invoice-backed requests: WSM $100, Parts Unlimited $0, TMS $0, BRP $250.
- [x] **15.** Require **individual item verification** of exact supplier SKU, quantity, cost, stock and fitment before transmitting an order command. No demo SKU ordering.
- [x] **16.** Send the reviewed retail manifest to the **Windows desktop order outbox** and record its SHA-256 checksum; acknowledge “connector required / not purchased” instead of pretending checkout succeeded.
- [x] **17.** Track retail parts through vendor states: verified → queued → ordered/backordered → shipped → received → customer picked up. Require supplier confirmation for progress states.
- [x] **18.** Provide an independent **cash / externally approved Dejavoo / verified or pending Zelle** ledger on retail parts invoices; split payments and method-specific refunds have duplicate/overpay checks.
- [x] **19.** Hide pending Zelle amounts from confirmed paid totals and block a retail counter release until the full amount is actually received.
- [x] **20.** Show retail parts invoices waiting pickup separately for paid vs unpaid customers.
- [x] **21.** Keep a **signed inventory movement ledger** with source invoice/PO/stock-count references, reject inventory sales without real issued invoice IDs, reserve damage/write-off and cycle counts for owner/manager, and refuse negative stock counts.
- [x] **22.** Record owner-approved restock requests separately from physical inventory; an approved purchasing request does **not** increase on-hand stock.
- [x] **23.** Maintain local service appointments, detect obvious overlapping schedules and generate standards-based `.ics` imports for Google Calendar or Apple Calendar. Phoenix-local appointments stay in Arizona time even when the owner is traveling.
- [x] **24.** Add optional owner-controlled **Google Calendar OAuth2 adapter**: expected account `jetskiarizona@gmail.com`; encrypted refresh token; ten-minute one-time state; HTTPS callback; deterministic event ID; truthful `synced`/`error`/`local_only` state. Not live without owner grant and Google Cloud credentials.
- [x] **25.** Preserve the latest AZ Jet Ski + Powersports logo throughout Windows POS, owner mobile and Shop Operations.
- [x] **26.** Add **Launch Readiness** view with integration blockers and progress rather than leaving prerequisites hidden in developer notes.
- [x] **27.** Keep the prior V10 customer address, billing address snapshots, Dejavoo **manual verified receipt**, DocuSign PDF preparation, customer-facing photos/updates and technician workflow.

## 2. Live implementation and verification tasks (do before launch)

### Phase A — shop data and core POS

- [ ] **28.** Install the new executable on the actual Windows 10/11 x64 POS/server computer. Ensure Node.js 22.16+ is installed or correctly bundled; set strong passwords and session/agent tokens in `.env`.
- [ ] **29.** Back up the existing V10 database *and uploads folder* before upgrading. Make a copied-database restore test; never overwrite existing customer records with an empty demo DB.
- [ ] **30.** Conduct a full owner walkthrough: existing customer → add second vehicle → edit HIN/hours → create WO on selected unit → check in → diagnostic photos → estimate → approve → payment → release.
- [ ] **31.** Verify two concurrent desk employees do not overwrite each other's changes and all key status transitions are logged.
- [ ] **32.** Test a real customer with **two checked-in vehicles**; verify both remain on-site until individually checked out and the customer count is one.
- [ ] **33.** Test parking location/keys handoff and physical custody reconciliation every evening.
- [ ] **34.** Run end-of-day **cash drawer, Dejavoo P1 settlement, verified Zelle, refunds, taxes, and deposits** reconciliation with the accountant; fix disagreements before replacing existing POS.
- [ ] **35.** Validate state and city retail/repair sales-tax rules with the accountant. The app uses requested 9.1%, **not a legal determination**. Clarify separately stated non-taxable labor and taxable sales where appropriate.
- [ ] **36.** Add immutable **refund authorization roles** and recorded void reasons before allowing unattended end-of-day reconciliation.

### Phase B — Google scheduling

- [ ] **37.** Deploy an authenticated HTTPS URL with stable DNS and a secure reverse proxy; do **not** expose `:8787` to the Internet.
- [ ] **38.** Create a Google Cloud project, enable Google Calendar API, configure the OAuth consent screen and register a **Web application** redirect URI `https://YOUR-DOMAIN/api/shop/google-calendar/callback`.
- [ ] **39.** Set `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REDIRECT_URL`, `GOOGLE_CALENDAR_TOKEN_KEY` (64 hexadecimal characters from 32 cryptographically random bytes), and `GOOGLE_CALENDAR_EMAIL=jetskiarizona@gmail.com` in the **private shop server** environment.
- [ ] **40.** Owner opens **Shop Operations → Scheduling → Connect Google Calendar** and signs into `jetskiarizona@gmail.com`. Confirm Google grants Calendar events access, not an unrelated account. Never paste credentials in a chat.
- [ ] **41.** Test local appointment → real Google event on the named account; test failed sync/retry and duplicate avoidance. V11 syncs **Owner Tracker → Google** only, not full two-way editing or deletion.
- [ ] **42.** Later add conflict resolution with Google-imported external bookings; reschedule and cancellation propagation.

### Phase C — payment hardware and customer communications

- [ ] **43.** Obtain Dejavoo P1 **SPIn/iPOSpays** merchant integration credentials from the processor; confirm hosted invoice payment links are enabled and merchant/test terminal IDs.
- [ ] **44.** Test approved/declined/timeout/duplicate/partial-refund P1 flows on a real test merchant before enabling automatic capture. Never store card data in Owner Tracker.
- [ ] **45.** Verify sender permissions for `jetskiarizona@gmail.com` (authorized provider/SMTP) or a verified business-domain invoice address; send real test invoice to multiple mail providers and monitor bounces. Configure DKIM/SPF/DMARC where applicable.
- [ ] **46.** Connect DocuSign from the **standalone app OAuth**, approve the final legal authorization wording, send a test actual envelope and verify its completion webhook, signed PDF, estimate snapshot and customer ID association.
- [ ] **47.** Identify Epson TM printer model, Ethernet/USB connection and cash drawer kick cable; test receipt print, line items, tax, partial tender and authorized drawer opens with staff audit trail.
- [ ] **48.** Print customer pickup and retail parts receipts including paid vs remaining balance and deposit details.
- [ ] **49.** Set up automated appointment reminders and repair status notifications **only after** SMS/email consent, security and email deliverability controls are in place.

### Phase D — supplier ordering and inventory controls

- [ ] **50.** Obtain documented dealer API/DMS access for Parts Unlimited and BRP. Verify current WSM and TMS access via supported portal or approved dealer integration; do not scrape credentials into scripts as a substitute for stable APIs.
- [ ] **51.** Build provider-specific read-only price/stock/ETA adapters; compare fitment and SKU supersessions against OEM diagrams before suggesting alternatives.
- [ ] **52.** After dealer sandbox approval, enable actual order submit **only with exact per-line confirmation** and persist vendor-generated confirmation IDs. Retry intelligently without duplicates.
- [ ] **53.** Block parts without a customer invoice, signed authorization or explicit owner-approved **inventory replenishment** purpose; show all exceptions in Shop Operations.
- [ ] **54.** Run initial warehouse/bin counts and label shelves; receiving must include packing slip or PO number and actual quantity scanned.
- [ ] **55.** Add barcode receiving, partial fulfillment, damaged shipments, warranty returns, cores, supplier credits and full supplier invoice matching.
- [ ] **56.** Add recurring bin cycle counts and permissioned write-offs; flag excessive shrinkage and unauthorized stock consumption.
- [ ] **57.** Measure average parts ETA, fill rate, freight economics, and missed promised dates by supplier.

### Phase E — employee and mobile hardening

- [ ] **58.** Test iPhone owner/technician screens on real devices; camera permissions, uploads, large files, low-signal connectivity and customer-visible vs private note access.
- [ ] **59.** Add enforced per-work-order advisor responsibility and purchase ceilings (for example owner approval required above a configurable dollar cap).
- [ ] **60.** Build two-person sign-off for high-risk refunds, discounts, stock adjustments and extraordinary supplier orders.
- [ ] **61.** Implement employee shift/tech time tracking, promised-date SLA alerts, and QC signatures tied to each unit.
- [ ] **62.** Conduct role-by-role penetration testing: owner, manager, service writer, advisor, technician, parts, viewer. Audit data access and unauthorized bulk exports.
- [ ] **63.** Encrypt backups offsite, rotate tokens, test disaster recovery and establish retention/access policy for customer and vehicle data/photos.

### Phase F — marketing, retention and growth

- [ ] **64.** Add **separate, affirmative marketing opt-in** at service intake (email/SMS), record timestamp/source, respect STOP/unsubscribe; do not treat repair-update permission as marketing consent.
- [ ] **65.** Build service reminder journeys by unit/model: preseason PWC, winterization, supercharger maintenance, Can-Am clutch/belt, dune season readiness, and scheduled follow-up after repairs.
- [ ] **66.** Track service source and campaign attribution (Google Business Profile, SEO landing page, referral, Facebook, repeat customer, fleet).
- [ ] **67.** Trigger a **neutral** review request after eligible completed pickup, without gating reviews based on satisfaction or incentivizing selectively.
- [ ] **68.** Create quote/estimate aging alerts, declined-work follow-up, overdue invoice reminders and pickup-after-ready sequences with documented consent.
- [ ] **69.** Create a customer/unit service-history portal that supports rebooking and opt-in recommendations without exposing other customers' information.
- [ ] **70.** Build supplier-matched special-order product pages only when pricing/MAP policies, fitment and inventory are actually verified; avoid posting automatically without compliance checks.
- [ ] **71.** Add fleet/marina rental account schedules and preventive maintenance for recurring monthly revenue.
- [ ] **72.** Report lifetime customer revenue, gross margin, repeat rate, quote conversion, labor sold vs clocked, lead-to-repair turnaround and per-campaign return on ad spend.

## 3. Acceptance paths that must never regress

| User journey | Expected behavior |
|---|---|
| New customer / address / first vehicle / new work order | Proper owner–vehicle link, editable details, itemized invoice |
| Existing customer / second vehicle / edit vehicle | Existing history retained, no cross-customer contamination |
| Unit physically checked in before ticket opened | New ticket automatically attached to on-lot custody record |
| Two units checked in by one customer | Customer filter shows one person, lot view shows two machines |
| Unit ready but unpaid | Appears **Payment Pending**, blocked from checkout |
| Unit ready and fully paid | Appears **Ready for Pickup**, checkout logs physical release |
| Parts-only walk-in customer | Retail parts invoice without invented vehicle/repair |
| Retail WSM cart $45 + $60 | Below threshold first, eligible at $105 only after invoice and exact-SKU checks |
| Repair part request without invoice/approved estimate | Visible purchasing exception; no reviewed order manifest |
| Advisor attempts employee administration | Access denied |
| Technician adds photo/private note/part request | Private data not shown to customer; no unauthorized direct ordering |
| Restock approval but item not yet received | On-hand remains unchanged |
| Pending Zelle before bank verification | Paid amount unchanged; pickup blocked |
| Calendar disconnected | Local appointment and ICS available; **not** reported Google-synced |
| Live email/dealer/Dejavoo/DocuSign not configured | Clear “not sent / not purchased / not charged” status |

## 4. Launch gate

Do not switch off the existing live POS or rely on the new system for financial reporting until: a complete Windows/phone rehearsal passes; the merchant processor and tax accountant sign off; on-hand inventory is counted; restorable backups are verified; the supplier order integrations are tested with order receipts; and HTTPS plus access controls are production-tested.
