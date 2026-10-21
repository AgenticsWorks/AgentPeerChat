/* Pairing trusts a personal Agent to open the owner's browser workspace. No
   second permission step or handwritten access key is needed after connecting.
   Revocation, disabled Agents and revoked device keys still take effect. */
CREATE TRIGGER principals_agent_browser_default
AFTER INSERT ON principals WHEN NEW.kind = 'agent'
BEGIN
  UPDATE principals SET can_help_owner_login = 1 WHERE id = NEW.id;
END;
/* Apply the new default once to existing connected and pending personal Agents.
   Subsequent explicit withdrawals remain off; migrations are not rerun. */
UPDATE principals SET can_help_owner_login = 1
WHERE kind = 'agent' AND (active = 1 OR EXISTS (
  SELECT 1 FROM pairings WHERE principal_id = principals.id AND status IN ('invited','pending')
));
