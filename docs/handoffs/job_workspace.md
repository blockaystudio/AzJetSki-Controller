# Unified repair workspace

- Owned `public/app.js`, new `public/job-workspace.js`, and `test/job-workspace.test.mjs`.
- Job detail, POS line edits, retained authorizations, customer links, work updates/photos/notes, parts and audit history now share six accessible tabs. Customer/unit, stage, assignment, current approval and the credit-aware account summary remain in the job header. Historical signatures never imply current approval.
- `Payments & Documents` mounts the shared `mountAccountWorkspace` component in job context; successful financial changes refresh the header and pickup eligibility. Imported financial edits remain protected by that module and the existing server rules.
- Inline estimate and sale-line editors preserve revision guards. New Repair and customer/unit repair entry points route to `/intake.html` with selected identity.
- URLs retain job/tab identity, browser Back restores the prior view, keyboard arrows/Home/End operate tabs, delayed job loads cannot replace a newer selection. Unsaved forms guard tab changes and departure; tab switches retain drafts, successful saves clear only the acknowledged form.
- Contextual pickup verifies the exact job/unit in current custody, Ready state, settled balance and refund obligation immediately before the existing checkout request. Existing server custody/financial checks remain authoritative.
- Verified with supported Node 22: both modules pass syntax; seven focused tests cover stale approval, credit/refund summary, pickup identity and balance gates, dirty text/checks/files, retained/restored financial drafts and tab URLs. Real-browser integration belongs to `phase3_browser` and root.
- No backend, credentials, live/review data, CI or commits changed by this agent.
