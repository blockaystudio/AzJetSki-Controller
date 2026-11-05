# Active shop development plan

Updated 2026-11-05. One AZ Jet Ski shop; repairs and counter parts sales have equal priority. Use PROJECT_STATE.md for current status and bounded handoffs for implementation evidence.

| Work | Status | Next gate |
| --- | --- | --- |
| Correctness, navigation and visual foundation | Verified in previews.2–3 | Actual shop device acceptance |
| Repair intake, job workspace and retained approvals | Verified | Actual staff walkthrough through pickup |
| Shared repair/counter accounting and special orders | Verified | Terminal/bank/drawer reconciliation on shop devices |
| Desktop POS and Calendar shortcuts | Implemented in preview.4 | Install current software on actual Windows register |
| Scheduling customer creation and directory search | Implemented | Owner workflow acceptance |
| Recovered customer directory and receipt history | Implemented; privately installed | Review exceptions; keep history read-only and reconcile active stock/prices/balances separately |
| Calendar transport and explicit sync | Verified in preview.6 | Owner Google consent and explicit provider sync acceptance remain required |
| Historical search/history pagination | Verified in preview.6 | Every matching record reachable; customer/query scopes and mobile paging pass |
| Permanent Linux server package | Local container/recovery verification passed | Hosting account and owned domain still needed |
| Permanent server provisioning | Pending owner setup | Provision selected host; public HTTPS, restart persistence, stable OAuth callback and offsite restore |
| Shop pilot | Pending acceptance | Named staff, reconciled starting records, Windows/phone/peripherals and selected live providers |

## Delivery order

1. Preview.6 local checks passed: 307 tests/subtests, 111 syntax files, legacy HTTP regressions and shop/history browser journeys. Publish the verified source and desktop package; refresh the existing owner-private review while preserving private credentials and imported data.
2. Complete Google consent from the app's Calendar. Explicitly sync and confirm a fictional appointment before customer scheduling.
3. Provision the selected permanent server using SERVER_DEPLOYMENT.md once the account/domain is available.
4. Run the device/peripheral walkthrough and encrypted offsite recovery. Begin a controlled shop pilot after starting data and payments balance.

Record proven outcomes only. Manual terminal references and supplier ordering are valid initial workflows. Automated merchant charging, unattended purchasing and native iOS signing remain optional.

## Durable context

GitHub stores source, tests, this plan and concise handoffs. Update the existing Drive planning folder and existing checkpoint/plan files after verified milestones; do not duplicate folders. Planning snapshots must exclude credentials, customer records, private recovery identifiers and financial reconciliation details.

Existing folder: https://drive.google.com/drive/folders/1SMdizJKuDJaa7AXDfuCZGL0BBI5FJyUp . File identifiers are recorded in PROJECT_STATE.md.
