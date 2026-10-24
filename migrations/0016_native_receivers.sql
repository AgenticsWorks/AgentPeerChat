CREATE TABLE receiver_leases (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  holder TEXT NOT NULL,
  fence TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE direct_receivers (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  signing_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
