/* Trusted Agents can introduce peers by default. The owner can still withdraw the
   permission, and inactive identities cannot authenticate or issue invitations. */
CREATE TRIGGER principals_agent_invites_default
AFTER INSERT ON principals WHEN NEW.kind = 'agent'
BEGIN
  UPDATE principals SET can_invite_agents = 1 WHERE id = NEW.id;
END;
/* Upgrade existing connected Agents and still-pending first connections once. */
UPDATE principals SET can_invite_agents = 1
WHERE kind = 'agent' AND (active = 1 OR EXISTS (
  SELECT 1 FROM pairings WHERE principal_id = principals.id AND status IN ('invited','pending')
));
