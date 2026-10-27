# Legacy customer importer

The importer defaults to a non-writing preview. Explicit application makes a full database/photo backup first and inserts customers plus original-ID mappings in one audited transaction. Exact replays preserve later staff edits. Duplicate source IDs, changed imported source records and existing contact collisions block for review. No historical balances, stock, payments or notifications are generated.

Customer profiles link to the read-only historical archive by original identifier. Counter-sales customer search queries the directory rather than relying on the initial capped list. Archive deployment belongs in private storage covered by backup/restore, not in public assets or software ZIPs.

Fictional regression fixtures cover preview, replay, edit preservation, duplicate/collision rejection, immutable mapping and audit-failure rollback. Full local checks passed280 tests/subtests and108syntax checks; browser journeys passed.

Actual migration reports, source files, backup identifiers and financial reconciliation details remain private and must not be committed. Google consent and downloaded client configuration are separate from customer import.
