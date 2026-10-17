/* Existing invitations retain explicit verification. New invitations authorize one device by default. */
ALTER TABLE pairings ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 1 CHECK(approval_required IN (0,1));
