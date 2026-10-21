CREATE TABLE agent_receiving_activity (
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  last_checked_at TEXT NOT NULL
);
CREATE INDEX messages_sender_seq ON messages(sender_id, seq);
CREATE INDEX deliveries_recipient_ack ON deliveries(recipient_id, acked_at);
