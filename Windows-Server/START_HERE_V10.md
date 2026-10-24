# Owner Tracker V10 — Start Here

**Status:** development/QA release. **Not certified for financial production or live supplier purchases.** The latest Windows executable is compiled for Windows 10/11 x64. The interface and routes require a Node.js 22.16+ (22.x) runtime; `runtime/node.exe` is not bundled.

## Local desktop installation

1. Use a modern Windows 10 or 11 **64-bit** front-desk PC (not the Windows XP QuickBooks PC). Download Node.js 22.x 64-bit from the official provider and install it.
2. Unzip this **entire** package to `C:\OwnerTracker`. Do not move `OwnerTrackerDesktop.exe` out of the extracted directory.
3. Run `windows\SETUP_FIRST.cmd` **once**. Set a long unique owner password and secrets; the setup creates `.env` locally. Keep `.env` private and do not copy it into shared attachments.
4. Start `OwnerTrackerDesktop.exe` and leave its console open. Launch `http://127.0.0.1:8787` on the shop PC. For local testing, use `/owner.html`, `/tech.html`, `/billing.html`.
5. Create a test customer with address, add a unit, open a work order, enter a taxable part and separately stated labor, and examine totals before touching a real record. Try cash, externally approved card, pending Zelle, splits and refunds with *test references* only.
6. The default tax rate is **9.1%**, at the owner's accountant's direction. The rate is editable under **POS Hardware & Tax**, and saved on the job. Tax applies to item lines marked taxable. Confirm actual applicable classification, taxability, and Arizona filings with the accountant before processing real invoices.
7. For actual iPhone use outside the POS machine, set up a properly authenticated HTTPS deployment. Never simply open port 8787 to the Internet.

## Customer address

New customers require **street address, city, state and ZIP/postal code**. Apartment/suite is optional. Separate billing address can be selected. Editing the customer updates the customer profile; an invoice that has already been issued retains the **billing address snapshot at issue time**, while new invoices use the current details. Historical QuickBooks data migration is deferred by request.

## Billing, authorizations and payments

The app records cash, Dejavoo P1 **externally approved** card transactions, pending/verified Zelle, splits, and recorded externally completed refunds. Pending Zelle does not lower balances. The app will not collect card numbers. Actual charging and hosted payment links are NOT connected to Dejavoo yet.

To directly email customer invoices: configure a public HTTPS URL (`PUBLIC_BASE_URL`), `INVOICE_FROM_EMAIL`, plus either `SENDGRID_API_KEY` for a verified sender or the `SMTP_*` settings for a properly authorized mail account. The app reports whether the provider **accepted** the message; that is not proof the customer received it. Invoice links are token-based and expire; do not include private staff URLs in email.

DocuSign: creates job-specific PDFs with the customer address, unit, scope, estimate, and signature anchors. **Actual sending disabled** until the document language is approved and a separate DocuSign OAuth app is connected and authenticated. ChatGPT's DocuSign plugin connection is **not** the standalone POS application's OAuth credential.

## Supplier parts ETA

The Parts Command Center displays an ETA when an employee enters it from a supplier response or a configured status provider supplies one. `Not provided` means there is no reliable ETA: the application **does not invent one**. Orders and carts are still subject to human SKU/vehicle/quantity/price/availability review. Thresholds: WSM **$100**, Parts Unlimited **$0**, TMS **$0**, BRP **$250**. Live checkout stays OFF until approved dealer connections have passed real sandbox tests.

## Epson receipt printer and connected cash drawer

Only printers compatible with ESC/POS raw Ethernet port 9100 are currently supported. Install the printer/cash drawer on the shop LAN and enter its fixed private IPv4 in `.env` (`EPSON_PRINTER_IP`). Confirm the exact Epson TM model, printer IP, interface, cable and compatible RJ drawer kick-pin setting before live use. In **POS Hardware & Tax**, print a test receipt and deliberately test the drawer with a reason. A successful network write does **not** confirm paper physically printed or the drawer opened. For USB/Windows-printer-only models, a new Windows print-spooler adapter will be required; do not force raw TCP.

## Safety and backups

Run `windows\BACKUP_NOW.cmd` and periodically test restoring a copied backup to a nonproduction folder. The actual POS data stays in the local SQLite database and media folders. Keep both private and backed up; never email your raw data folder casually. Only one computer should own the local SQLite database; employee phones connect to the server rather than accessing SQLite over a file share.

## To finish the live integrations

See `INTEGRATIONS_V10.md` and `OWNER_QA_V10.md`. Do not paste merchant passwords, private keys or SMTP app passwords into a public conversation. Enter them in the shop PC's protected environment once integration setup is confirmed.
