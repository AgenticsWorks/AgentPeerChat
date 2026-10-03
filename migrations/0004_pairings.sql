CREATE TABLE pairings (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  created_by TEXT NOT NULL REFERENCES principals(id),
  code_hash TEXT NOT NULL UNIQUE,
  token_id TEXT NOT NULL UNIQUE,
  token_hash TEXT,
  verification_code TEXT,
  status TEXT NOT NULL DEFAULT 'invited' CHECK(status IN ('invited','pending','approved','rejected')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX pairings_pending ON pairings(status, expires_at);
