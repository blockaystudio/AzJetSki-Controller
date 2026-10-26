# Repair, counter-sale and financial-exception browser acceptance

Owner: `phase3_browser`. Scope: `Windows-Server/test/browser-shop.py` and new
`Windows-Server/test/browser_workspace.py` / `browser_operations.py`. No application, server, CI, or suite
runner edits by this agent.

The suite launches Chromium against a disposable real Node 22 server. Only
`src/`, `public/`, `scripts/`, and `package.json` are copied. A fresh database is
seeded with fictional review records. The subprocess environment is explicitly
constructed and never copies `.env`, shop data, uploads, backups, provider
credentials, or the review runtime. A fictional HTTPS public base permits real
invoice creation; requests and customer authorization navigation stay on
loopback. Request-client checks forward only the disposable browser login cookie
because Chromium and Playwright differ on Secure cookie handling over loopback.

Added browser journeys:

- New customer, mailing address, vehicle, decimal estimate, repair, physical
  check-in, and exact customer/unit/job/custody association.
- Existing customer with a second vehicle. Its accepted vehicle POST response is
  deliberately lost; the UI requires selecting the saved record and never
  repeats the write. Customer and vehicle counts verify no duplicates.
- All six contextual job tabs at 390, 768, and 1440px; native decimal validity,
  reduced motion, screenshots, no document overflow, deep-link reload,
  back/forward, unsaved-tab cancellation, draft preservation, and reload discard.
- Delayed job response and delayed account response after navigating to another
  job cannot replace the selected job or financial controls.
- Embedded initial/revised invoice, retained replacement pointers, no added debt,
  confirmed fictional cash payment, exact ledger amount and remaining balance.
  A held payment POST locks other account buttons; a separate invoice draft
  survives refresh and still triggers the unsaved-change guard.
- Customer signing in an anonymous browser context, then revised estimate and
  authorization; previous signed record and snapshot hashes remain unchanged,
  the new authorization retains the revised full estimate and needs a decision.
- Revised customer signature, final revised invoice/payment, Ready, contextual
  repair pickup and a fresh completion timestamp. Both customer units are checked
  in; only the selected paid unit leaves custody, while the second job stays open.
- Technician intake access gate. Existing standalone billing selection/race,
  keyboard, mobile empty-state, contrast, and truthful-outcome coverage remains.
- Existing counter stock lookup, one stock issue, split tender, pickup and receipt
  now use the shared account widget and ledger, with populated screenshots at
  all three widths.
- Reviewed supplier manifest, deposit, partial receiving, deliberately lost
  successful receipt response, exact retry, final payment/receipt and pickup.
  A paid but incompletely received line remains blocked. Two receipt allocations
  produce exactly two receipts and two original invoice-linked stock sales.
- Pending Zelle blocks pickup until bank confirmation. One of two stock items is
  credited with tax, physically returned and restocked once, then refunded against
  its original Zelle payment. Combined repair/retail daily close has zero method
  discrepancies. Changing the selected business date removes stale close controls.

Browser findings fixed by the owning agents during acceptance: shared account
money inputs lacked explicit decimal input mode; populated retained authorization
SHA strings overflowed a 390px screen. A screenshot observation also prompted
keeping the selected tab visible when its viewport changes.

Run with supported Node 22 and Playwright/Chromium installed:

```sh
OWNERTRACKER_NODE=/home/agent/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node \
OWNERTRACKER_BROWSER_ARTIFACTS=/tmp/ownertracker-phase34-browser-final \
python Windows-Server/test/browser-shop.py
```

The local sandbox requires network permission to bind the disposable loopback
listener. `/usr/bin/chromium` is used automatically when Playwright's bundled
executable is absent.

Verified 2026-10-26: the complete browser suite passed with Node 22.23.4 and
Chromium 154. Final artifacts: `/tmp/ownertracker-phase34-browser-final`
(70 screenshots, `contrast.json`, source SHA-256 manifest and disposable server
log; no failure artifacts). All 75 copied application files matched current
source at verification. Python syntax
compilation passed. Recorded text/button/focus/status contrast ratios range
8.01–15.17. No uncaught page errors or outstanding browser failures remained.

## Special-order gap found and closed

Review against the assessment's complete daily-workflow gate found a real
special-order gap beyond the first green browser run: supplier lines could be
marked wholly received and picked up after a separate generic order received
only one of two items. The status operation created no original invoice-linked
stock sale, so that normal path could not support contextual physical returns.
An independent disposable real-router reproduction confirmed the mismatch.
The owning agents added quantity-based, idempotent supplier receipt allocation
and guarded verification, supplier carts and pickup. The durable browser journey
above passed against the corrected real server. Backend focused tests separately
cover historical reconciliation, return holds and verification/cart replay guards.
