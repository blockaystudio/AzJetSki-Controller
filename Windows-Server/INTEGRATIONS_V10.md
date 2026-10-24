# Owner Tracker V10 — Real integration requirements

## Dejavoo P1 / iPOSpays

**Already present:** cash/card/Zelle payment ledger, split payments and refunds, Dejavoo-approved transaction reference recording, prepared-only P1 charge/hosted payment link records. Card numbers never enter Owner Tracker.

**To make the P1 initiate charges or issue remote payment links:** Obtain the merchant **provider/processor name** and whether the P1 is provisioned for **iPOSpays**; exact P1 model/firmware, **Terminal Profile Number (TPN)**, enabled **SPIn / SPIn Cloud** integration, Register ID, authentication key/merchant-issued authorization, correct endpoint/environment and supported webhook/callback specification. Confirm whether the merchant account has **Hosted Payment Pages / Pay by Link / CloudPOS** enabled and get developer/sandbox access. Processor and device must both authorize this integration. DO NOT collect or store PAN/CVV on the POS server. Make adapter test: charge, decline, timeout, cancellation, partial approval, duplicate callback, refund/void and actual P1 receipt; reconcile by gateway IDs.

**Not available yet:** physical terminal initiation, live pay-by-link checkout, settlement confirmation and gateway callbacks.

## Customer invoice emails

**Implemented:** work-order-specific invoice snapshots and tokenized customer view; email generation through configured SendGrid or direct TLS SMTP; optional customer email entered per invoice; accepted/not-sent status logged. **Not configured:** live domain HTTPS, authenticated sender and SMTP/SendGrid account.

Recommended sender: `service@azjetski.com` or existing authorized shop mailbox. Set `PUBLIC_BASE_URL=https://your-secure-domain`, verified sender `INVOICE_FROM_EMAIL`, and either `SMTP_HOST/PORT/USER/APP_PASSWORD` or SendGrid API key. Do not embed credentials in an app bundle. Send a test invoice to a shop-controlled mailbox and verify inbox/spam/delayed/bounced cases. Add queue/retries, suppression/opt-out handling and bounce delivery webhooks before broad production use.

## Epson TM + cash drawer

**Implemented:** basic ESC/POS receipts with shop/WO/cost/tax/payments/customer address and raw cash-drawer kick command for a network printer; guarded owner/staff endpoint with required manual reason and audit entry.

**Need:** exact **Epson model**, whether Ethernet, USB, Wi-Fi or Windows driver, **cash drawer model**, compatible RJ modular cable, static printer LAN address and the proper drawer kick pin. Confirm printer width (58mm vs 80mm) and cutter commands. Most USB printers require separate driver/spooler integration, not the current TCP socket adapter.

**Not certified:** physical print, proper code page, totals on the specific paper width, drawer electrical behavior, hardware failures and reconnect after power loss.

## Supplier ETAs

**Implemented:** optional ETA / availability field on each supplier offer and cart, order ETA and tracking status in Parts Command Center. Owner/tech views display ETA when present; missing ETA is `Not provided`. Manual staff entry is supported.

**Need:** approved live supplier status/availability credentials and feed contracts for WSM, Parts Unlimited, TMS, BRP. Verify that supplier ETA is a projected date (not guaranteed delivery); log source/time checked and alert when shipment status does not update. No actual supplier order has been placed from V10.

## DocuSign

**Implemented:** job-specific generated PDF containing customer address, unit identifiers, scope, exact estimate and signatures; immutable snapshot, send-disabled policy, external envelope mapping structure.

**Need:** authorization wording signed off by shop/legal reviewer, DocuSign developer integration key/OAuth consent+refresh mechanism, account ID/base URL, verified customer email, real send/callback flow, completed PDF and certificate of completion archival. Being connected to DocuSign in this ChatGPT chat is **not** a credential that Owner Tracker can reuse.

## iPhone / cloud

**Implemented:** owner/tech responsive phone screens and server permission roles. **Need:** HTTPS domain deployment, password/PIN risk controls and hardened auth, production monitoring, media storage, iPhone camera uploads on actual devices, reverse proxy, offsite backups and operational recovery tests.
