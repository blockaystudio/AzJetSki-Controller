## 11.1.0-preview.7 — phone vehicle check-in

- Vehicle category dropdown and VIN-only creation/editing fields.
- Shop assignment roster configuration preserves staff login access.
- Calendar arrivals prepare exact customer/vehicle intake with retry-safe repair linkage.
- Phone inspection checklist, Dirt lot/Front lot, durable drafts and at least two internal arrival photos before completing physical check-in.
- Completed records/photos retain identity, privacy and custody history.
- Backup-first contactless customer archival and roster CLIs; explicit --env resolves runtime-relative paths and includes uploads in backups.

Employee names and cleanup are private runtime configuration, separate from the clean software download. Owner provisions employee login passwords privately. Google consent and actual phone/camera/peripheral acceptance remain shop setup tasks.

# Owner Tracker V11 — Release notes

**Implemented:** physical custody with check-in/out audit; paid pickup vs ready/unpaid queues; on-lot vehicles and checked-in customer filters; adviser/parts purchasing role; invoice/authorization-backed purchasing guard; separate retail-only parts invoices, cart thresholds and immutable desktop manifests; retail cash/card/Zelle payments, ETA/status and pickup progression; safeguarded stock movement with restock requests that do not inflate inventory; local appointment schedule, calendar ICS, and optional encrypted Google OAuth adapter; Launch Readiness screen; current supplied powersports logo. Old V10 functions remain in the package.

**External blockers:** Google Calendar not authorized (no Google Cloud OAuth keys or HTTPS host yet); Dejavoo/P1, DocuSign app credential, Epson physical printer and supplier order portals not live-tested. No real dealer order is placed by V11.

**QA:** Automated V6, V8, V9, V10, V11 regressions verified at code/API level. The execution environment's browser policy blocks direct automated graphical rendering (`ERR_BLOCKED_BY_ADMINISTRATOR`), so on-device visual testing is still needed. This is not a complete POS financial-production certification.
