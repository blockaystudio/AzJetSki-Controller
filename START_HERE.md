# Owner Tracker V11 — Windows POS + Owner iPhone + Technician App

## Install / Upgrade

1. On a current **Windows 10/11 64-bit** POS computer, **back up the complete previous OwnerTracker data/database/photos first**. Do not mix the new release with previous test fixtures.
2. Install **Node.js 22.16+ (22.x)** from https://nodejs.org/en/download unless the official Node executable is safely deployed inside `runtime/node.exe`.
3. Extract the **entire Windows-Server folder** to `C:\OwnerTracker`. Leave `OwnerTrackerDesktop.exe` beside `src`, `public`, `windows`, and `scripts`.
4. On a **new installation**, run `windows\SETUP_FIRST.cmd` and protect the generated password. On an **upgrade**, preserve your original `.env` and production `data` folder and verify backups first. Do not copy development test databases into production.
5. Launch `OwnerTrackerDesktop.exe`, then on the Windows PC open `http://127.0.0.1:8787`.
6. **Shop Operations V11:** `http://127.0.0.1:8787/shop-ops.html`; owner iPhone web UI `.../owner.html`; technician web UI `.../tech.html`. Mobile access outside the Windows machine requires secure authenticated HTTPS hosting.
7. Test with fake customer data first. Create/edit customer → add/edit vehicle → check in → create work order → add parts/labor → authorization → collect payment → Ready → check out. Verify that **pending payment and pickup ready remain different queues**.
8. Test **retail special order** using an existing customer with no vehicle checked in → create retail parts order → add priced parts → issue locked invoice → source/verify exact supplier SKUs → review supplier cart → queue desktop manifest. **Desktop queue is not vendor purchasing.**
9. Inspect **Launch Readiness** and `LONG_TERM_IMPLEMENTATION_PLAN.md`. Do not activate live supplier purchases until verified integrations have passed real-world test cycles.

## Google Calendar connection (not automatically connected)

- In Google Cloud, enable **Google Calendar API** and configure an OAuth 2.0 **Web Application** for a stable authenticated HTTPS Owner Tracker domain. Use callback URI `https://YOUR-HTTPS-DOMAIN/api/shop/google-calendar/callback`.
- On the server, add to the private `.env` file:

```
GOOGLE_CALENDAR_CLIENT_ID=...
GOOGLE_CALENDAR_CLIENT_SECRET=...
GOOGLE_CALENDAR_REDIRECT_URL=https://YOUR-HTTPS-DOMAIN/api/shop/google-calendar/callback
GOOGLE_CALENDAR_TOKEN_KEY=64-hex-digits-generated-from-32-random-bytes
GOOGLE_CALENDAR_EMAIL=jetskiarizona@gmail.com
```

- Sign in to Owner Tracker as owner → **Shop Operations → Scheduling → Connect Google Calendar**, then authorize **jetskiarizona@gmail.com**. The adapter does **one-way creation** from Owner Tracker to Google Calendar with deterministic event IDs; event edits/cancellations originating on Google do not sync back yet.
- The app treats appointment form dates as **Phoenix local time (UTC-7, year-round)**, even when your phone is traveling; verify the intended time when creating the first real appointment.
- If offline or unconfigured, appointments are still saved **locally** and downloadable as `.ics`; no message will falsely claim Google synchronization. Owner Tracker's OAuth keys are not the same as a ChatGPT Google Calendar plugin connection.

## Supplier and accounting controls

- Vendor minimums remain **WSM $100, Parts Unlimited $0, TMS $0, BRP $250**. Every line must have invoice/approval backing and exact verification.
- The default shop tax is **9.1% as requested**, adjustable in existing POS tax settings; the accountant must approve legal tax treatment/classification before live collection.
- Actual Dejavoo P1 charging, DocuSign e-signature submission, merchant web payments, Epson USB/physical drawer, and unattended supplier purchasing are **NOT LIVE** merely because the app UI is available.
- Direct email invoicing from the previous release requires authorized SMTP or SendGrid provider settings and public HTTPS invoice link. Verify actual delivery separately.

## Security / backup

- Never publish or email the SQLite database, employee PINs, merchant API keys, Google OAuth refresh tokens or DocuSign private credentials.
- Do not expose `8787` to the public Internet. Use HTTPS reverse proxy, proper authentication, firewall and secure backups.
- Save the full application code and `.env` in a protected folder. Run and **restore-test** a backup before adding actual customer/shop data.
