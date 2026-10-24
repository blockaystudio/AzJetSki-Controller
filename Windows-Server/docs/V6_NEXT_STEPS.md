# Owner Tracker V6 — What's done and what's next

## Working in this release

**Windows POS/server:** local SQLite with customers, editable vehicles, linked work orders, labor/part sale lines, employee roles, parts requirements, photos, customer updates, authorizations, audit trail and backup/restore. Windows launcher EXE is cross-compiled; requires Node 22.x installed on Windows PC.

**Owner app:** native SwiftUI source and installable web app. Dashboard, job list, four supplier carts, per-item verification and command queuing.

**Tech app:** native SwiftUI source and installable web app. Assigned work, separate photo customer updates (visible/private flags), internal diagnostic notes, and parts-needed requests.

**Supplier thresholds:** WSM $100; Parts Unlimited $0; TMS $0; BRP $250. Tests prove accumulation behavior and no unattended checkout.

**Purchasing controls:** order command captures immutable payload with SHA256 and operator, exact line items, unit cost and originating vehicle/work order. Dealer purchase is not attempted until proper vendor connectors can be approved and tested; no fabricated supplier confirmation.

## Priority 1 — On shop PC

Install Node 22.x + V6 package, run SETUP_FIRST, then OwnerTrackerDesktop.exe. Create 1 real customer, 1 vehicle and 1 work order. Confirm edit, part requests and camera upload through employee phone on secure hosted address. Validate real service writer workflow, then make automatic daily backup task and offsite restore validation.

## Priority 2 — Remote/iPhone deployment

Provision a trusted HTTPS domain with access controls, deploy/reverse-proxy V6 server, test iPhone mobile web apps and customer approval links. Use Mac + Xcode + Apple signing for two native iOS apps/TestFlight. Native SwiftUI source is **not yet built or signed**.

## Priority 3 — Real supplier integrations

For each WSM, Parts Unlimited, TMS, and BRP dealer account, confirm whether the account has approved API/DMS ordering, or must use the portal manually. Add vendor adapters separately using a secure vault on server. For real orders, support live SKU fitment/price/stock verification, shipping/freight, taxes, PO number, transaction receipt, duplicate detection and failure recovery. Do not store dealer logins in iOS app.

## Priority 4 — True financial POS

Add secure payment terminal integration, cash/check/deposit tracking, itemized receipts/invoices, sales tax and tax reporting, refund and return controls, accounting export and daily register close. Inventory counts/reservation before supplier purchasing. Reconcile a month's books alongside existing system before cutover.

## Priority 5 — Shop workflow

Parts received barcode scanning and units ready for work; tech clock in/out and sold-vs-actual; standardized QC and inspection checklists, customer photo authorization, serialized warranty records, time-to-pickup, fleet and rental management, review follow-up, per-repair profit and owner exceptions.

## Known limitations / safety

- The original QBPOS bridge is no longer needed; past data import is intentionally deferred.
- The current machine does NOT have an authorized vendor-ordering integration.
- Every iOS application requires device/Xcode QA, code signing and TestFlight/App Store steps before native installation.
- Windows desktop `.exe` is not fully standalone; official Node.js runtime is a prerequisite.
- Browser-driven graphical QA was not completed in this container (browser policy blocked local host). API integration coverage passed. Both native platforms need real-device QA.
- DO NOT put payment card numbers, supplier passwords or unencrypted database backups into this app or chat.
