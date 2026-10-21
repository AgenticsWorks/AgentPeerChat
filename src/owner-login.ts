import type { Env, Principal } from './types';
import { body, checkOrigin, fail, hash, id, secret, sessionCookie, str } from './security';

// Trusted paired Agents can open the owner's workspace by default, using a
// ten-minute single-use browser link. The owner may explicitly withdraw this capability.
// The link code is a 256-bit secret shown once and stored only as a SHA-256 hash; redeeming
// it requires a same-origin POST and mints an HttpOnly session, never an access key.
const TTL_MINUTES = 10;
const QUOTA = 10;
const RETENTION_HOURS = 24;
const NEEDS_GRANT = 'Browser access was explicitly disabled for this Agent. Its saved pairing is unchanged; the owner can restore browser access in Contacts.';

const time = () => new Date().toISOString();
const json = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});
// The live delegation, issuer and issuer access key are rechecked wherever a grant can still
// be consumed, so withdrawing the permission, disabling the Agent or revoking that key ends
// every unresolved link at once — even after the request was already authenticated.
const ISSUER_AUTHORIZED = `EXISTS (SELECT 1 FROM principals issuer WHERE issuer.id = owner_login_grants.issuer_id
  AND issuer.kind = 'agent' AND issuer.active = 1 AND issuer.can_help_owner_login = 1)
  AND EXISTS (SELECT 1 FROM tokens issuer_key WHERE issuer_key.id = owner_login_grants.issuer_token_id
  AND issuer_key.revoked_at IS NULL AND (issuer_key.expires_at IS NULL OR issuer_key.expires_at > ?))`;
// Keep the grant binding for as long as its remembered browser remains authorized.
// Only orphaned, revoked or expired sessions are eligible for retention cleanup.
const expiredGrants = () => `(redeemed_at IS NULL AND expires_at <= ?) OR (redeemed_at IS NOT NULL AND redeemed_at < ?
  AND NOT EXISTS (SELECT 1 FROM tokens live WHERE live.owner_login_grant_id = owner_login_grants.id
    AND live.revoked_at IS NULL AND (live.expires_at IS NULL OR live.expires_at > ?)))`;
const cleanupStatements = (env: Env, now: string): D1PreparedStatement[] => [
  env.DB.prepare(`DELETE FROM tokens WHERE kind = 'session' AND owner_login_grant_id IN
    (SELECT id FROM owner_login_grants WHERE ${expiredGrants()})`)
    .bind(now, new Date(Date.now() - RETENTION_HOURS * 3600000).toISOString(), now),
  env.DB.prepare(`DELETE FROM owner_login_grants WHERE ${expiredGrants()}`)
    .bind(now, new Date(Date.now() - RETENTION_HOURS * 3600000).toISOString(), now)
];

async function instanceOwner(env: Env) {
  const row = await env.DB.prepare("SELECT id, name FROM principals WHERE kind = 'owner' LIMIT 1").first<{ id: string; name: string }>();
  if (!row) fail(409, 'not_initialized', 'Create the instance owner before minting sign-in links.');
  return row;
}

export async function ownerLoginRedeem(request: Request, env: Env, path: string) {
  if (path !== '/owner-login/redeem' || request.method !== 'POST') return null;
  // Same-origin only: a link opened by a browser is confirmed by an explicit POST from the
  // app itself. GET prefetch or cross-origin posts never consume a grant.
  checkOrigin(request);
  const code = str((await body(request)).code, 'code', 256), codeHash = await hash(code);
  const mark = crypto.randomUUID(), redeemedAt = time();
  const session = secret('ags'), sessionId = id('tok');
  await env.DB.batch([
    ...cleanupStatements(env, redeemedAt),
    // Only the real unredeemed-to-redeemed transition carries this request's unique mark, so a
    // replayed or concurrent redemption can never mint a second session or leave an orphan token.
    env.DB.prepare(`UPDATE owner_login_grants SET redeemed_at = ?, redeem_mark = ? WHERE code_hash = ?
      AND redeemed_at IS NULL AND expires_at > ? AND ${ISSUER_AUTHORIZED}`).bind(redeemedAt, mark, codeHash, redeemedAt, redeemedAt),
    env.DB.prepare(`INSERT INTO tokens(id, principal_id, hash, label, kind, parent_id, expires_at, owner_login_grant_id)
      SELECT ?, g.owner_id, ?, 'Owner sign-in from Agent link', 'session', g.issuer_token_id, ?, g.id
      FROM owner_login_grants g WHERE g.redeem_mark = ? AND g.redeemed_at IS NOT NULL`)
      .bind(sessionId, await hash(session), null, mark),
    env.DB.prepare('UPDATE owner_login_grants SET redeemed_session_id = ? WHERE redeem_mark = ? AND redeemed_session_id IS NULL').bind(sessionId, mark)
  ]);
  const grant = await env.DB.prepare('SELECT redeemed_session_id, owner_id FROM owner_login_grants WHERE code_hash = ?').bind(codeHash)
    .first<{ redeemed_session_id: string | null; owner_id: string }>();
  if (!grant || grant.redeemed_session_id !== sessionId)
    fail(410, 'invalid_login_link', 'This sign-in link expired, was withdrawn, or was already used. Ask the Agent for a new one.');
  const owner = await env.DB.prepare('SELECT id, name, kind FROM principals WHERE id = ?').bind(grant.owner_id).first();
  // No access key is returned: the browser session is the only credential this path mints.
  return json({ principal: owner }, 200, { 'Set-Cookie': sessionCookie(request, session) });
}

export async function ownerLoginAgent(request: Request, env: Env, path: string, p: Principal, tokenId: string, tokenKind: 'access' | 'session') {
  const delegated = p.kind === 'agent' && p.can_help_owner_login === 1;
  if (path === '/owner-login-links' && request.method === 'POST') {
    if (p.kind !== 'agent') fail(403, 'agent_required', 'Only an Agent can hold sign-in help permission.');
    if (tokenKind !== 'access') fail(403, 'access_key_required', 'Sign-in links are minted with an Agent access key, not a browser session.');
    if (!delegated) fail(403, 'login_permission_required', NEEDS_GRANT);
    const b = await body(request);
    let threadId: string | null = null;
    if (b.thread_id !== undefined && b.thread_id !== null && b.thread_id !== '') {
      // An Agent may only point the owner at a thread it already knows; the owner sees every
      // thread once signed in, so no broader lookup is offered here.
      threadId = str(b.thread_id, 'thread_id', 80);
      const member = await env.DB.prepare('SELECT 1 FROM thread_members WHERE thread_id = ? AND principal_id = ?').bind(threadId, p.id).first();
      if (!member) fail(404, 'not_found', 'Thread not found.');
    }
    const owner = await instanceOwner(env);
    const code = secret('agl'), grantId = id('olg'), expires = new Date(Date.now() + TTL_MINUTES * 60000).toISOString(), now = time();
    await env.DB.batch([
      ...cleanupStatements(env, now),
      // Permission, issuer key validity and quota live inside the insert, so a concurrent
      // create that loses a withdrawal, key-revocation or boundary race leaves no orphan grant.
      env.DB.prepare(`INSERT INTO owner_login_grants(id, code_hash, issuer_id, issuer_token_id, owner_id, thread_id, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM principals issuer WHERE issuer.id = ?
        AND issuer.kind = 'agent' AND issuer.active = 1 AND issuer.can_help_owner_login = 1)
        AND EXISTS (SELECT 1 FROM tokens issuer_key WHERE issuer_key.id = ?
        AND issuer_key.revoked_at IS NULL AND (issuer_key.expires_at IS NULL OR issuer_key.expires_at > ?))
        AND (SELECT COUNT(*) FROM owner_login_grants WHERE issuer_id = ? AND redeemed_at IS NULL AND expires_at > ?) < ?`)
        .bind(grantId, await hash(code), p.id, tokenId, owner.id, threadId, expires, p.id, tokenId, now, p.id, now, QUOTA)
    ]);
    if (!await env.DB.prepare('SELECT 1 AS ok FROM owner_login_grants WHERE id = ?').bind(grantId).first()) {
      // Authentication may predate a concurrent withdrawal or key revocation; report the live reason.
      const issuer = await env.DB.prepare('SELECT active, can_help_owner_login FROM principals WHERE id = ?').bind(p.id)
        .first<{ active: number; can_help_owner_login: number }>();
      if (!issuer || issuer.active !== 1 || issuer.can_help_owner_login !== 1) fail(403, 'login_permission_required', NEEDS_GRANT);
      const key = await env.DB.prepare('SELECT revoked_at, expires_at FROM tokens WHERE id = ?').bind(tokenId)
        .first<{ revoked_at: string | null; expires_at: string | null }>();
      if (!key || key.revoked_at || (key.expires_at && key.expires_at <= now))
        fail(401, 'unauthorized', 'Access key is invalid, expired, or revoked.');
      fail(409, 'login_link_quota', `Let your existing sign-in links expire or be used before creating another (${QUOTA} open at a time).`);
    }
    const fragment = `#owner-login=${code}${threadId ? `&thread=${encodeURIComponent(threadId)}` : ''}`;
    return json({ login_link: {
      id: grantId, expires_at: expires, thread_id: threadId, fragment,
      // Convenience URL from this request's own origin; API clients may build the same link
      // from their validated private profile base using `fragment` instead.
      url: `${new URL(request.url).origin}${new URL(request.url).pathname.replace(/\/api\/v1(?:\/.*)?$/, '')}/${fragment}`
    } }, 201);
  }
  if (path === '/owner-login-links' && request.method === 'GET') {
    if (p.kind !== 'agent' || !delegated) fail(403, 'login_permission_required', NEEDS_GRANT);
    const { results } = await env.DB.prepare(`SELECT id, thread_id, expires_at, created_at FROM owner_login_grants
      WHERE issuer_id = ? AND redeemed_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 100`).bind(p.id, time()).all();
    return json({ items: results });
  }
  return null;
}
