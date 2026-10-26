# Guided repair intake — Phase 3

Implemented `Windows-Server/public/intake.html` and `intake-ui.js`; app entry wiring and shared navigation/styles belong to the workspace/visual agents.

- Four accessible steps: find/add customer with mailing and optional billing address; choose/add that customer's vehicle; complaint, decimal basic estimate, assignment and priority; review and optional physical check-in with lot/key details. Completion opens the job deep link.
- Owner, manager, service writer and advisor access; technician/other roles receive the desk-access guard. Staff select named records rather than entering database IDs.
- Customer, vehicle and repair identities are retained immediately after confirmed saves. Drafts persist in session storage per employee and clear on completion or confirmed cancellation. Back navigation preserves entered data; leaving unfinished intake requires confirmation.
- Creation endpoints lack idempotency support. Busy guards prevent simultaneous submissions; network/5xx/invalid-success outcomes block repeat mutations. Recovery searches saved records; repairs use a stable generated reference to avoid choosing historical work. Reload during an in-flight write also enters recovery.
- The existing create-job API does not apply assignment. Intake saves the repair first, captures its revision, then applies assignment through the existing authenticated PATCH route. Assignment conflicts require review of saved state. Subsequent failures cannot recreate the repair.
- Existing on-site custody is reused through the backend's automatic new-job association. Intake reads the lot before optional check-in, refuses mismatched associations and never repeats an uncertain custody write.

Validation: supported Node 22 syntax check and **16 focused tests** in `Windows-Server/test/intake-ui.test.mjs` passed (run directly with Node for individual TAP results). Browser acceptance agent confirmed real new-customer, existing-customer second-vehicle and check-in journeys; broader evidence is owned by that agent. No backend, test runner, review runtime or live data edits.

Integration: root should add `test/intake-ui.test.mjs` to the isolated suite's explicit file list. Browser coverage is in the acceptance agent's `browser_workspace.py`, called by `browser-shop.py`.
