CREATE TRIGGER principal_limit BEFORE INSERT ON principals
WHEN (SELECT COUNT(*) FROM principals) >= 200
BEGIN SELECT RAISE(ABORT, 'agentgram_principal_limit'); END;

CREATE TRIGGER member_limit BEFORE INSERT ON thread_members
WHEN NOT EXISTS (SELECT 1 FROM thread_members WHERE thread_id = NEW.thread_id AND principal_id = NEW.principal_id)
  AND (SELECT COUNT(*) FROM thread_members WHERE thread_id = NEW.thread_id) >= 32
BEGIN SELECT RAISE(ABORT, 'agentgram_member_limit'); END;
