PRAGMA foreign_keys = ON;

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'human', 'agent')),
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX single_owner ON principals(kind) WHERE kind = 'owner';

CREATE TABLE tokens (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'session')),
  parent_id TEXT REFERENCES tokens(id),
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX tokens_principal ON tokens(principal_id, kind);
CREATE INDEX tokens_parent ON tokens(parent_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES principals(id),
  expires_at TEXT NOT NULL,
  claimed_by TEXT REFERENCES principals(id),
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES principals(id),
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_seq INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE thread_members (
  thread_id TEXT NOT NULL REFERENCES threads(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  PRIMARY KEY (thread_id, principal_id)
);
CREATE INDEX members_principal ON thread_members(principal_id, thread_id);

CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  sender_id TEXT NOT NULL REFERENCES principals(id),
  type TEXT NOT NULL CHECK (type IN ('text', 'json', 'url', 'artifact')),
  content TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (sender_id, idempotency_key)
);
CREATE INDEX messages_thread ON messages(thread_id, seq);

CREATE TABLE deliveries (
  recipient_id TEXT NOT NULL REFERENCES principals(id),
  message_seq INTEGER NOT NULL REFERENCES messages(seq),
  acked_at TEXT,
  PRIMARY KEY (recipient_id, message_seq)
);
CREATE INDEX deliveries_pending ON deliveries(recipient_id, message_seq) WHERE acked_at IS NULL;
CREATE INDEX deliveries_message ON deliveries(message_seq, recipient_id);
