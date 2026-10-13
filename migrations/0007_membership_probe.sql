/* A single-column index is ordered by (principal_id, rowid), allowing MAX(rowid)
   to seek directly to an Agent's newest membership, including older threads. */
CREATE INDEX members_principal_latest ON thread_members(principal_id);
