CREATE TABLE review_bridge_requests (
  id TEXT PRIMARY KEY NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  headers_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','complete')),
  claim_token TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  response_status INTEGER,
  response_headers_json TEXT
);
--> statement-breakpoint
CREATE INDEX review_bridge_queue ON review_bridge_requests(state,created_at);
--> statement-breakpoint
CREATE TABLE review_bridge_chunks (
  request_id TEXT NOT NULL REFERENCES review_bridge_requests(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('request','response')),
  sequence INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(request_id,direction,sequence)
);
--> statement-breakpoint
CREATE TABLE review_bridge_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_seen INTEGER NOT NULL
);
