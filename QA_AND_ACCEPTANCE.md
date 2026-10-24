# Owner Tracker V11 — QA and acceptance report

**Date:** October 8, 2026  
**Scope:** development/API regression and build verification on Linux; real Windows, iPhone, printer, merchant and supplier endpoints remain separate acceptance gates.

## Tested and passed

- Existing V6 repair POS: owner login; add/edit customer and vehicle; prevent cross-customer vehicle links; repair jobs, progress, notes, photos, parts requests, vendor carts, thresholds and desktop command receipt.
- Existing V8 payments: partial cash; Dejavoo **manually verified** approval references; pending/verified Zelle; duplicate and overpayment prevention; refunds and recomputed balances.
- V9 invoice/signature document creation: invoice snapshots, PDF authorization, draft-not-sent DocuSign behavior; P1 requests marked **prepared, not charged**.
- V10 addresses and receipt controls: customer address, alternate billing address, immutable issued-invoice address snapshot, 9.1% configured tax example, printer bytes and printer-disabled behavior without real hardware.
- V11 physical custody: create vehicle, check in, attach work order, prevent duplicate/wrong-owner check-in, separate unpaid ready job from paid pickup, block early release, check out with audit.
- V11 retail counter special order: no fictitious vehicle required; issue actual invoice before sourcing; freeze post-issue item changes; verify each vendor SKU; consolidate WSM to $100; queue audited **non-purchasing** desktop manifest.
- V11 retail split tender: cash, Dejavoo externally approved card receipt, unverified Zelle left pending; due balance must be zero before pickup.
- V11 Advisor role: can access assigned repair and purchasing flows; cannot manage users, approve restock or perform stock shrink/write-off.
- V11 stock: cannot sell non-existent stock; sales require an invoice number that exists in app and is issued; received stock requires supplier-order reference; restock approval does not inflate on-hand; every adjustment audited.
- V11 calendar: local appointment creation, overlap warning, ICS generation; Google connection correctly marked disconnected when no credentials; explicit Phoenix timezone conversion in UI. Google API remote sync **not yet certified**.
- V11 JS file syntax, Windows PE x64 compilation, release archive CRC checks, no test SQLite database or private `.env` in distributable.

## Not tested / not yet operational

- Real signed iOS distribution, on-device Safari and camera permission flows, concurrency of 2+ front-desk terminals.
- Physical Windows 10/11 POS executable launch with live users and restore of a production database.
- Google Cloud OAuth credentials and live jetskiarizona@gmail.com event creation; **one-way sync only** until improved.
- Supplier dealer purchasing/ETA APIs and actual posted supplier confirmation IDs; current supplier commands remain non-purchasing manifests.
- Dejavoo P1 terminal authorization, settled remote payment links, actual email sending/delivery, DocuSign actual signed envelope, Epson TM receipt printing/cash drawer kick.
- Accountant validation of Phoenix tax classification, full card/cash/Zelle daily close, regulatory/commercial production hardening.
- Visual browser automation was blocked by the runtime browser policy (`ERR_BLOCKED_BY_ADMINISTRATOR`); source/API verification does not replace a real desktop/mobile interaction pass.

**Release classification:** development/testable build only, not production-certified POS/accounting/supplier-ordering platform.
