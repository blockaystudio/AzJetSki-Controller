# Owner Tracker V10 automated QA report

Executed with Node.js 22 and a temporary SQLite database using synthetic customer/unit/work-order data. Test runner: `npm test`.

Results: PASS for customer required street/city/state/ZIP and optional separate billing address, customer address/ZIP search/edit; adding and linking vehicle; wrong-customer vehicle rejection; new and editable work orders; 9.1% tax on flagged taxable line items and separately stated labor; saved tax on work order; invoice billing-address snapshots remaining unchanged after customer edits; PDF DocuSign authorization showing customer address; guarded SMTP state; ESC/POS receipt command and explicit cash drawer pulse bytes; safe error without configured printer; technician roles, photos, parts requests; supplier threshold review and duplicate prevention; cash/card/Zelle partial/split payments and refunds; backup and restore.

No live merchant/card transactions, direct emails, signed DocuSign envelopes, supplier purchases, Epson receipt printing, cash-drawer actions or actual iPhone/Windows application GUI launch occurred during testing. A Playwright Chromium browser walkthrough was attempted but blocked at local navigation by the execution environment's browser administrator policy. The limitations are not reported as passes.
