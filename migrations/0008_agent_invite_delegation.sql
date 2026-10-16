/* Explicit, revocable owner delegation letting one Agent issue its own invitations.
   Default 0: installing or approving an Agent never grants invitation permission. */
ALTER TABLE principals ADD COLUMN can_invite_agents INTEGER NOT NULL DEFAULT 0 CHECK (can_invite_agents IN (0, 1));
/* Delegated issuers list and count only their own unresolved invitations. */
CREATE INDEX pairings_issuer ON pairings(created_by, status, expires_at);
/* Written only by the atomic pending-to-approved transition. Later statements key on the
   unique per-request mark, so a replayed approval can never mint a key or reactivate a
   disabled Agent, even within the same millisecond. */
ALTER TABLE pairings ADD COLUMN approved_at TEXT;
ALTER TABLE pairings ADD COLUMN approval_mark TEXT;
