/* Explicit, revocable owner delegation letting one trusted Agent mint short-lived
   single-use OWNER browser sign-in links. Default 0: installing, approving or inviting an
   Agent never grants sign-in help, and invitation delegation does not confer it either. */
ALTER TABLE principals ADD COLUMN can_help_owner_login INTEGER NOT NULL DEFAULT 0 CHECK (can_help_owner_login IN (0, 1));
/* One-time grants: only the SHA-256 hash of the 256-bit code is stored, never the code.
   redeemed_session_id binds the single redeem transition to the browser session it minted,
   so authenticate can recheck the live delegation, issuer and issuer key on every request. */
CREATE TABLE owner_login_grants (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  issuer_id TEXT NOT NULL REFERENCES principals(id),
  issuer_token_id TEXT NOT NULL REFERENCES tokens(id),
  owner_id TEXT NOT NULL REFERENCES principals(id),
  thread_id TEXT,
  expires_at TEXT NOT NULL,
  redeemed_at TEXT,
  redeem_mark TEXT,
  redeemed_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX owner_login_grants_issuer ON owner_login_grants(issuer_id, redeemed_at, expires_at);
CREATE INDEX owner_login_grants_session ON owner_login_grants(redeemed_session_id);
/* Sessions minted through a grant point back at it; every other session (ordinary owner
   sign-in) keeps NULL and stays governed only by the existing key/session rules. */
ALTER TABLE tokens ADD COLUMN owner_login_grant_id TEXT REFERENCES owner_login_grants(id);
