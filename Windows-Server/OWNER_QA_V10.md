# Owner's acceptance walkthrough — V10

Run these scenarios before calling Owner Tracker production-ready. `Automated PASS` means the server/API assertions were executed with synthetic data; it is not a physical-device certification.

| Workflow | Test path / acceptance criteria | Current status |
|---|---|---|
| New customer | Add with required street, city, state, ZIP, phone/email | Automated PASS |
| Existing customer | Search name/phone/email/city/ZIP; edit mailing address | Automated PASS |
| Different billing address | Uncheck "billing same"; add complete separate address | Automated PASS |
| Preserve invoice history | Issue invoice; edit customer address; existing invoice retains original | Automated PASS |
| New vehicle | Attach a PWC/UTV/ATV/boat/motorcycle to customer | Automated PASS |
| Existing vehicle | Edit year/make/model/VIN/HIN/hours, navigate from customer | Automated PASS at API level |
| Prevent wrong vehicle | Block linking a vehicle owned by another customer | Automated PASS |
| New WO | Customer > specific vehicle > work order > technician | Automated PASS |
| Repair and estimate | Add/edit parts and labor; tax 9.1% on taxable lines; preserve payments | Automated PASS |
| Customer approval | Photo/scope authorization packet generated for actual WO, but not sent | PDF generation PASS; live send BLOCKED |
| Technician activity | Add private note and customer-visible photo; parts request | Automated PASS; iPhone hardware not tested |
| Parts sourcing | Missing matches, carts, review SKU/vehicle/qty/price | Automated PASS with synthetic offers |
| Supplier thresholds | WSM $100, PU $0, TMS $0, BRP $250 | Automated PASS |
| Order ETA | When available, display ETA, otherwise explicitly "Not provided" | Implemented; live feed not connected |
| Supplier checkout | Safe desktop command only; never silently purchases | Automated PASS safe mode; live BLOCKED |
| Cash | Confirm counted payment, ledger/balance recompute | Automated PASS |
| Dejavoo card | Record P1 receipt reference **after external APPROVED** | Automated PASS; device integration BLOCKED |
| Zelle | Keep pending out of paid totals until bank verification | Automated PASS |
| Split payment | Cash + card + Zelle total without duplicates or overpay | Automated PASS |
| Refund | Record externally completed method-bounded refund, protect balance | Automated PASS |
| Invoice email | Create secure snapshot; report provider delivery acceptance | Simulated non-sent PASS; real mail untested |
| Receipt | Send ESC/POS bytes to configured Epson printer | Generator PASS; hardware untested |
| Cash drawer | Require staff confirm/reason and store audit | Control PASS; physical kick untested |
| Local backup / restore | Database+audit+media backup and recovery | Automated PASS; shop offsite test needed |
| Windows launcher | Compile Windows x64 EXE and start real Windows process | Cross-compiled PASS; actual Windows boot untested |
| Owner iPhone | Secure remote shop control, actual sign-in/photo stream | Responsive source present; remote HTTPS pending |

## Workflow and navigation improvements still needed

- Collapse crowded desktop navigation into role-based Shop, POS/Billing, Parts, Admin sections for faster front desk use.
- Avoid alert()/prompt() for production transactions; replace with validation-rich forms and confirmation screens.
- Implement a receipt/invoice number policy, day-close reports, payment settlement checks, accounting export and a sales-tax review screen.
- Add customer duplication suggestions on name/phone/email and household/fleet account handling.
- Add photo consent, document retention, customer-facing notification preview and reliable email/SMS delivery webhooks.
- Add supplier ETA timestamps, overdue warnings, carrier tracking refresh, shipment reconciliation and part-level stock/fitment validation.
- Add specific Epson printer model testing, offline error handling, and USB spooler support if needed.
- Restrict manual changes to authorized invoice lines after DocuSign approval; require supplements and reauthorization for price/scope increases.
- Run actual Windows 10/11 and physical iPhone workflow testing for all of the above; do not claim production certification based solely on synthetic tests.

**Current release policy:** Do not use Owner Tracker as the sole accounting POS until the items above are validated, particularly live Dejavoo and taxes.
