# Shop desktop and scheduling rollout

Updated 2026-11-07. Shop Desktop opens directly from the Windows launcher, with Sales / POS, Calendar, Customers / Units, Repairs, Accounts and Previous POS History shortcuts. Scheduling supports directory search and customer creation without requiring a vehicle or repair job.

## Google Calendar

Target account: jetskiarizona@gmail.com. The owner-supplied OAuth configuration has been installed privately in the review runtime. Owner Google consent is still pending. Drive account access and Calendar authorization are separate connections.

The hosting service changed the review origin during preview.6 publication. In Google Cloud, add this exact Authorized redirect URI to the existing Web OAuth client first: `https://azjetski-ownertracker-review.coastliquidators.chatgpt.site/api/shop/google-calendar/callback`. The private runtime callback is updated; the downloaded original client JSON is retained unchanged.

Then open Calendar, choose **Connect Google Calendar**, sign in as the target account and approve. Saving an appointment is local; **Sync to Google** explicitly publishes it. Once linked, rescheduling or cancelling the appointment updates its existing Google event with version/conflict protection. Existing unrelated Google events are not imported.

For a separate Windows or permanent server installation:

1. Enable Google Calendar API in the shop Google Cloud project, configure consent and create a Web application OAuth client. During Testing, add the shop account as a test user; refresh tokens may expire after seven days. Complete Google's publishing requirements for continued use.
2. Register the exact callback `https://YOUR_SHOP_HOST/api/shop/google-calendar/callback`. The callback must reach the same application database used by the desktop.
3. Keep the downloaded client JSON private. In the application directory, run `node scripts/configure-google-calendar.mjs /private/path/client.json`. This preserves other settings, validates the callback and generates a private encryption key. It refuses to replace existing credentials.
4. Restart the server, connect from Calendar and approve using the target account. Explicitly sync a fictional appointment and confirm the Google outcome before customer scheduling.

The temporary review address depends on the managed workspace. The permanent server needs a stable HTTPS address. A different callback or installation requires its own correct configuration; credentials are excluded from software downloads and GitHub.

## Recovered POS data

The recovered archive adapter preserves original customer and transaction IDs, historical receipts, line items, tax and tenders. The customer importer creates active customer profiles with immutable original-ID links, a full pre-import backup, collision checks and replay protection. Exact replays preserve subsequent staff edits. Detailed migration evidence and recovery copies remain private.

The private review has the recovered customer directory and historical archive installed. Historical receipt searches and customer purchase history are read-only. They create no current debt, charge, refund, stock movement or notification. Inventory, prices and opening balances require separate reconciliation before becoming active shop data. Do not infer missing customer associations or replay old receipts as new sales.

Install the current software package separately from the private data restore. The public ZIP contains application code only. Preserve `.env`, data, photos, original-ID mappings and archive paths on updates. Keep real source files, backups and credentials out of GitHub and planning snapshots.

## Store acceptance still required

- Select the permanent hosting account and owned domain; provision the tested server package and stable HTTPS callback.
- Complete owner Calendar consent and an explicit sync check.
- Set up named staff accounts and review permissions on the actual register.
- Reconcile starting inventory/prices/balances and review migration exceptions without guessing missing links.
- Walk through a fictional cash/card-reference sale, split tender, pending Zelle confirmation, receipt print, return, repair approval and pickup on actual Windows/phone devices. Card entries record terminal transactions; they do not charge cards.
- Confirm drawer/printer/barcode behavior, restart persistence and a restore from an encrypted offsite copy with its separately held key.

Do not record these owner/provider/device checks as complete based only on automated application tests. Manual terminal references and supplier ordering remain supported initial workflows.

## Preview.7 — shop arrival workflow

Vehicle creation and editing use a category dropdown and a single VIN field. Original stored identifiers remain available for historical records. Assignment choices are configured separately from login access; Tyler Whitener and Jacobo Medina are the shop roster. Existing staff credentials and roles are preserved. For newly configured employee records, the owner sets private login credentials through staff administration when needed. No shared/default employee password is supplied.

From Desktop or Calendar, choose **Prepare scheduled check-ins** and the Arizona calendar day. An appointment can open an exact existing repair or prepare intake for its original customer and vehicle. A prepared appointment is not a physical arrival. Saving a new appointment-linked repair is transactional and retry-safe. This reads the app schedule; it does not import unrelated Google events. The Google consent/callback gate above remains separate.

On the phone, open **Phone check-in / photos** from the job or lot workspace. Confirm customer, vehicle and VIN, choose **Dirt lot** or **Front lot**, record keys (or No keys), condition and belongings, complete the four inspection confirmations, and take at least two arrival photos. Drafts and queued photos retain retry keys. The vehicle enters the lot only after **Complete check-in** succeeds. Completed records and internal check-in photos are retained; later profile edits do not relabel the completed identity. Assigned technicians can perform the procedure for their own jobs. New UI entry points use this workflow; the prior authorized staff custody API remains for integration compatibility.

Customer cleanup is backup-first and archive-only. It removes an active profile only when every phone, email and service/billing address field is blank, and keeps original IDs, receipts, work orders and vehicle links. A partial contact value is retained for review. CLI commands default to a non-writing preview and require explicit --apply. Keep operational cleanup reports and backups private.
