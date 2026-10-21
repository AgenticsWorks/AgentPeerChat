/* Preserve live browsers; never restore expired or explicitly revoked sessions. */
UPDATE tokens SET expires_at = NULL
WHERE kind = 'session' AND revoked_at IS NULL
  AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
