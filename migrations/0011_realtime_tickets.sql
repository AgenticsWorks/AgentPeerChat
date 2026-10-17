CREATE TABLE realtime_tickets (
  hash TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES tokens(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE INDEX realtime_tickets_expiry ON realtime_tickets(expires_at);
