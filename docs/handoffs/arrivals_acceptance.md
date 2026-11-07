# Scheduled arrival browser acceptance — 2026-11-07

`Windows-Server/test/browser-arrivals.py` passes against a real disposable Node 22 server and Chromium. Run from `Windows-Server` with `OWNERTRACKER_NODE=/path/to/node22 python test/browser-arrivals.py`; it uses the same Playwright/Chromium requirements as `browser-shop.py`.

The runner copies only `src`, `public`, `scripts` and `package.json`, starts on loopback with a fresh SQLite database, creates fictional customers/vehicles/appointments, and calls `configureShopRoster` only in that database. Its staff accounts have no known employee credentials. Private configuration, review data, uploads, backups and provider credentials are never copied or inherited. No external browser requests occurred.

Verified at 390/768/1440 pixels:

- Phoenix date boundaries include late evening saved on the next UTC date and exclude adjacent Phoenix dates.
- Appointment intake selects the saved customer, creates a vehicle through the category dropdown and VIN field, and offers exactly Tyler Whitener/Jacobo Medina for assignment while preserving unrelated active staff.
- Repair creation atomically retains `appointment_id`; retry and repeated existing-repair preparation return the original job. Wrong-customer preparation/check-in requests fail without creating another repair or draft.
- Preparing intake and saving phone drafts/photos leave the vehicle off-lot. Parking choices are Dirt lot/Front lot. Completing with zero or one saved photo fails.
- Two distinct valid PNG files pass through the browser image decoder and actual upload endpoints; authenticated media reads return distinct JPEG bytes. Checklist, condition, keys, parking and photos survive reload and a fresh authenticated device context.
- Completion retains checklist/photos, creates custody at Front lot, rejects edits, and returns the same custody event on exact retry. The arrivals card then shows physical arrival.

Final source-freeze run passed: `/tmp/ownertracker-arrivals-final/` (`acceptance.json`, source hashes, screenshots and server log). All 99 copied source files exactly matched current source after the run; see `source-manifest-verification.json`. Python compilation passed. This proves automated browser behavior; actual shop phone/camera and owner Google consent remain separate acceptance steps. Customer cleanup safety belongs to its separate disposable tests.
