/* Mentions address named recipients while group history stays shared. */
ALTER TABLE messages ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
