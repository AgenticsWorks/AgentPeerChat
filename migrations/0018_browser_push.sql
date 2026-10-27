/* Per-instance Web Push keys are generated lazily; never exported by the API. */
CREATE TABLE push_configuration (id INTEGER PRIMARY KEY CHECK(id=1), public_key TEXT NOT NULL, private_key TEXT NOT NULL);
CREATE TABLE push_subscriptions (
 endpoint_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id), token_id TEXT NOT NULL REFERENCES tokens(id),
 endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'en', updated_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_principal ON push_subscriptions(principal_id);
CREATE INDEX push_subscriptions_token ON push_subscriptions(token_id);
