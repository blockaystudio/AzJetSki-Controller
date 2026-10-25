# Complete application private review

This Worker relays ordinary HTTP requests to the actual Node/SQLite application.
The Site remains owner-private and the local application still requires its own
employee sign-in. Use a dedicated fictional review database and no live provider
credentials. Stopping the managed runtime stops the application review.

The Worker needs a `DB` D1 binding, the schema in `drizzle/0000_review_bridge.sql`,
and a secret runtime variable named `REVIEW_BRIDGE_SECRET` of at least 32 random
characters. The bridge receives one JSON line on hidden stdin after its readiness
message. Piped stdin is supported; a terminal automatically disables input echo:

```json
{"siteUrl":"https://your-private-site.chatgpt.site","siteBearer":"<private Site service credential>","bridgeSecret":"<matching runtime secret>","localOrigin":"http://127.0.0.1:8787"}
```

Do not put those values into arguments, source, logs, environment examples or the
hosting manifest. The client preserves the managed session's HTTP proxy and CA
verification. No incoming request can change the fixed loopback destination.

Configure the isolated application with `PUBLIC_BASE_URL` equal to the deployed
Site origin and `TRUST_PROXY=true`. The bridge forwards only the application's
`ot_session` cookie, strips Site authentication cookies and identity headers, and
sets its own trusted forwarding protocol and host. A Site service bearer and the
independent bridge secret protect polling and response submission.

Requests and responses are capped at 12 MB. Queue contents expire after 30
seconds and use bounded D1 chunks so normal 8 MB photo uploads can pass. Claims
are atomic and never replayed after a timeout. A timed-out operation may already
have completed; reload its record before retrying. This is a development review
transport, not permanent production hosting or an offline synchronization system.

The verified Sites artifact layout has `.openai/hosting.json` at archive root,
`dist/server/index.js` for the Worker, and root `drizzle/` SQL migrations plus its
journal. The hosting manifest declares `"d1": "DB"` and the registered Site ID.
Sites provisions that logical binding and applies the schema before publication.
Tests run with `npm test` in this directory. Preserve the registered ID, exact
pushed source commit, owner-private audience and credential handling when publishing.
