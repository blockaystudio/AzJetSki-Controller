# Shop desktop and scheduling rollout

The Windows launcher now opens `/desktop.html`, with direct Sales / POS, Calendar, Customers / Units, Repairs and document/account access. The new scheduling customer form creates a directory customer and selects it in the appointment without creating a vehicle/job. Search uses the directory endpoint, including customers outside the initial 500-record list. An uncertain customer save blocks repeat creation until staff check the directory. Existing appointment inputs remain intact.

## Google Calendar — setup pending

Target account: jetskiarizona@gmail.com. No client ID, client secret, redirect URL or encryption key was present in the inspected app/review configuration. No Google connection has been completed. There is no connected Google Cloud provisioning or authenticated browser capability in this session to create an OAuth client on the owner's behalf.

1. In the shop's Google Cloud project, enable Google Calendar API, configure OAuth consent and create a Web application OAuth client. Add the account as a test user if using Testing; Google Testing refresh tokens can expire after seven days. Complete Google's publishing requirements for continued use.
2. Register the exact HTTPS callback of the actual shop server: `https://YOUR_SHOP_HOST/api/shop/google-calendar/callback`. It must route to the same database/server used by the desktop. A different review server cannot complete OAuth for the local Windows installation.
3. Download the client JSON privately. In the installed application directory, run `node scripts/configure-google-calendar.mjs /private/path/client.json`. It preserves other .env settings, validates the registered callback, generates an encryption key if absent, prints no credentials, and refuses to replace configured credentials. Do not commit or share the JSON/.env.
4. Restart the shop server. Sign in as owner/manager, open Calendar, choose Connect Google Calendar and approve as jetskiarizona@gmail.com. The OAuth request hints this account; the callback enforces the verified email.
5. Save and explicitly sync a fictional appointment. Confirm its Google outcome. Integration sends shop appointments to the primary Google calendar; arbitrary existing Google events are not imported. Appointments remain local until explicitly synced.

The app's Calendar setup link shows the callback for the current origin. The workspace review is temporary; store deployment needs a stable address or the local-only scheduling workflow until that is available.

## QuickBooks migration — explicitly waiting for owner upload

The owner will add the extracted old POS data to Drive and provide its location. Do not substitute unrelated files, infer receipts from work orders, or seed fabricated records. No legacy records have been imported in this milestone.

After the export arrives: identify its schema and version; stage a private copy; count customers/transactions and reconcile receipt/payment/tax totals; map persistent external IDs and possible customer duplicates; preserve historical receipt numbers/dates/items/tax/tenders/refunds; run a dry import and duplicate replay check on a disposable database; review exceptions; back up the chosen shop database/photos; apply the reviewed mapping there. Historical receipts must not create new receivables, card charges, stock issues or customer notifications. Keep raw exports and real customer data out of GitHub and the fictional review.

## Store opening gate

Install the updated Windows package with Node 22; preserve existing .env/data on upgrades. Use named employee accounts. On the actual register, walk through a fictional cash/card-reference sale, split tender, pending Zelle confirmation, receipt print and return, check the drawer/printer and restart persistence, then reconcile starting stock and customer/receipt counts after migration. Card entries record existing terminal transactions; they do not charge a card. Keep an encrypted backup and an external recovery copy.

Tomorrow's availability depends on receiving/reconciling the legacy export and completing the actual Windows/peripheral walkthrough. Neither data completeness nor the Google connection is represented as ready yet.
