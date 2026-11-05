# Calendar and history follow-up — preview.6

Updated 2026-11-05. Three confirmed gaps corrected:

- Google OAuth token exchange, userinfo, refresh, event sync and conflict resolution now share a verified HTTPS transport compatible with inherited HTTP/HTTPS CONNECT proxies. Normal CA validation remains enabled. Deadlines cover tunnel, TLS and body; response limits and sanitized errors protect credentials. Direct Internet connections remain supported when no proxy is configured.
- Saving a new appointment remains local even when Google is connected. Staff explicitly choose Sync to Google. Updates/cancellation of an already-linked event retain existing version/conflict handling. OAuth account verification, encrypted refresh-token storage and one-use state remain enforced.
- Historical customer and receipt searches return page totals and stable pages. Customer purchase history can reach older receipts beyond the previous 50-record cap. Previous/Next retain customer or captured search scope; a new search starts on page one. Archive access stays read-only and role-restricted.

Verification: 307 tests/subtests and 111 syntax files passed, including fictional OAuth/account/state/replay/local-save cases, 22 transport tests/subtests, archive reachability and source-hash preservation. All V6/V8/V9/V10/V11 HTTP regressions passed. Existing complete shop browser journeys passed at 390/768/1440, plus the new isolated history pagination browser check. Browser checks are registered in CI. Public Google OpenID metadata returned HTTP 200 through the managed proxy without application credentials or provider mutations.

No test used real imported shop data or live credentials. Detailed private migration/configuration reports remain outside GitHub. Owner Google consent, actual provider sync acceptance, permanent host/account/domain, reconciled active starting data, offsite restore and register/peripheral acceptance remain open gates. The temporary review depends on its managed runtime.

Runtime follow-up: hosting publication returned a changed review origin. Private PUBLIC_BASE_URL and OAuth callback now match that confirmed origin; the owner must add its exact redirect URI to the existing Google Cloud OAuth client before consent. The original downloaded JSON is preserved. An inherited stale container proxy address was corrected by recreating the existing app with current managed defaults and the same private data/configuration mounts. The container can reach public Google metadata with HTTPS 200. No audience change was made.
