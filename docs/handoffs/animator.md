# UI handoff

Implemented A08, A12, A14 and A15 in the shared web UI.

- `shared-ui.js` supplies six role-aware daily destinations, secondary settings, visible labels/scroll-region access, and explicit notification/calendar/supplier outcome text. Existing destinations remain reachable.
- Today gives equal repair/counter entry points and a distinct counter sales/special-order section with active, paid-ready and payment/refund pickup queues. Direct job and counter-sale links retain record context.
- Main money fields accept cents with decimal keyboards; quantity fields accept thousandths. Job rows expose keyboard-accessible links. Mobile empty states render once, photos have alternative text, and owner mobile cart review supports the same independent purchase approval as desktop.
- Inventory receiving routes to Management and customer returns to original Accounting transactions. Count/damage stays role-restricted. Stock sale selects retained invoice lines and keeps its request key across uncertain retries. Counter lookup fills SKU/description; invoice issuance, explicit stock issue, existing split payments and pickup use the corrected ledger.
- Unsupported manual stock approval contexts removed. Terminal job stages omitted from normal editable choices. Notification feedback distinguishes queued/unknown/failed; calendar feedback distinguishes local/pending/conflict/confirmed; supplier failures no longer announce success.

## Design tokens and motion

`ui-foundation.css` retains brand green `#79f28d`; background `#0b1018`, panels `#151f2c`, primary text `#f1f5fa`, muted `#b2bfd0`, focus `#b3dcff`, warning `#ffd166`, error `#ff9797`, control border `#53657b`. Status messages contain explicit text rather than relying on color.

Computed contrast on panel: primary text **15.17:1**, muted **8.90:1**, focus **11.55:1**, warning **11.52:1**, error **8.01:1**. Dark text on brand green is **11.96:1**; input boundary against `#0d1520` is **3.07:1**. Keyboard focus is a 3px offset outline.

Hover transitions are 140ms; section/toast entry is 180ms with 4px travel. `prefers-reduced-motion: reduce` removes transitions, animation and smooth scrolling. No repeating/ambient motion.

## Verification

`Windows-Server/test/browser-shop.py` starts a source-only temporary copy, empty database/uploads and fictional seed with sanitized provider-free environment. Honors `OWNERTRACKER_NODE`, `OWNERTRACKER_BROWSER`, `OWNERTRACKER_BROWSER_ARTIFACTS`.

Passed Chromium: all nine routes and all Operations/Management tabs at **390/768/1440**, no document overflow or page exceptions; equal CTAs, retail queue visibility, decimal `100.50`, keyboard job opening/focus, reduced motion, billing deselect and delayed selection races, zero/one/many technician lists, full in-stock counter sale with catalog lookup → invoice → one stock movement → cash/card split → pickup → receipt. Actual computed colors are checked numerically. Screenshots/contrast JSON: `/tmp/ownertracker-ui-check/` (CI emits the same artifacts to its configured directory).

Browser smoke is Chromium evidence; actual shop hardware/mobile Safari/provider acceptance remains outside this isolated run. Framework unchanged. No live runtime/data touched and no commit made.
