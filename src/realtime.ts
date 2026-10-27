import type { Env } from './types';
import { fail, hash, secret, checkOrigin } from './security';

// Tickets can only open an Agent's notification stream; never authorize the REST API.
export async function realtimeTicket(env: Env, principal: string, token: string) {
  if (!env.NOTIFICATIONS) fail(501, 'realtime_unavailable', 'This deployment uses periodic receiving.');
  const ticket = secret('wst'), expires = new Date(Date.now() + 60000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM realtime_tickets WHERE expires_at <= ?').bind(new Date().toISOString()),
    env.DB.prepare('INSERT INTO realtime_tickets(hash, principal_id, token_id, expires_at) VALUES (?, ?, ?, ?)').bind(await hash(ticket), principal, token, expires)
  ]);
  return { ticket, expires_at: expires };
}
export async function realtimeConnect(request: Request, env: Env) {
  if (!env.NOTIFICATIONS) fail(501, 'realtime_unavailable', 'This deployment uses periodic receiving.');
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') fail(426, 'upgrade_required', 'Use WebSocket.');
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) fail(403, 'origin_mismatch', 'Use the instance origin.');
  const protocols = request.headers.get('Sec-WebSocket-Protocol')?.split(',').map(s => s.trim()) || [];
  const ticket = protocols.find(s => s.startsWith('ticket.'))?.slice(7);
  if (!protocols.includes('apc-v1') || !ticket || ticket.length > 256) fail(401, 'unauthorized', 'A short-lived connection ticket is required.');
  const claimed = await env.DB.prepare('DELETE FROM realtime_tickets WHERE hash = ? AND expires_at > ? RETURNING principal_id, token_id')
    .bind(await hash(ticket), new Date().toISOString()).first<{ principal_id: string; token_id: string }>();
  if (!claimed || !await validStreamKey(env, claimed.principal_id, claimed.token_id)) fail(401, 'unauthorized', 'Connection ticket is expired, used, or revoked.');
  // No caller-supplied routing identity or secret is forwarded to the Durable Object.
  return env.NOTIFICATIONS.getByName(claimed.principal_id).fetch(new Request('https://notifications/connect', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'apc-v1', 'X-Agent': claimed.principal_id, 'X-Token-Id': claimed.token_id }
  }));
}
export async function validStreamKey(env: Env, principal: string, token: string) {
  return !!await env.DB.prepare(`SELECT 1 FROM tokens t JOIN principals p ON p.id=t.principal_id
    WHERE t.id=? AND p.id=? AND p.kind='agent' AND p.active=1 AND t.kind='access' AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at>?)
    AND (t.parent_id IS NULL OR EXISTS (SELECT 1 FROM tokens parent WHERE parent.id=t.parent_id AND parent.revoked_at IS NULL AND (parent.expires_at IS NULL OR parent.expires_at>?)))`)
    .bind(token, principal, new Date().toISOString(), new Date().toISOString()).first();
}
export async function notifyAgents(env: Env, principals: string[]) {
  if (!env.NOTIFICATIONS) return;
  await Promise.all([...new Set(principals)].map(async principal => {
    try { await env.NOTIFICATIONS!.getByName(principal).fetch(new Request('https://notifications/notify', { method: 'POST' })); }
    catch { console.warn(JSON.stringify({ code: 'notification_deferred' })); }
  }));
}

// Browser streams use their existing HttpOnly session and a separate hub. A web
// tab must never make an Agent appear to have a live native receiver.
export async function browserConnect(request: Request, env: Env, principal: string, token: string) {
  if (!env.NOTIFICATIONS) fail(501, 'realtime_unavailable', 'Realtime is unavailable on this deployment.');
  checkOrigin(request);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') fail(426, 'upgrade_required', 'Use WebSocket.');
  return env.NOTIFICATIONS.getByName('browser:' + principal).fetch(new Request('https://notifications/connect', {
    headers: {Upgrade:'websocket','Sec-WebSocket-Protocol':'apc-v1','X-Agent':principal,'X-Token-Id':token,'X-Browser':'1'}
  }));
}
export async function validBrowserKey(env: Env, principal: string, token: string) {
  const now = new Date().toISOString();
  return !!await env.DB.prepare(`SELECT 1 FROM tokens t JOIN principals p ON p.id=t.principal_id
    WHERE t.id=? AND p.id=? AND p.kind IN ('owner','human') AND p.active=1 AND t.kind='session' AND t.revoked_at IS NULL
    AND (t.expires_at IS NULL OR t.expires_at>?)
    AND (t.parent_id IS NULL OR EXISTS (SELECT 1 FROM tokens parent WHERE parent.id=t.parent_id AND parent.revoked_at IS NULL AND (parent.expires_at IS NULL OR parent.expires_at>?)))
    AND (t.owner_login_grant_id IS NULL OR EXISTS (SELECT 1 FROM owner_login_grants g
      JOIN principals issuer ON issuer.id=g.issuer_id JOIN tokens issuer_key ON issuer_key.id=g.issuer_token_id
      WHERE g.id=t.owner_login_grant_id AND g.redeemed_session_id=t.id AND g.redeemed_at IS NOT NULL
      AND issuer.active=1 AND issuer.can_help_owner_login=1 AND issuer_key.revoked_at IS NULL
      AND (issuer_key.expires_at IS NULL OR issuer_key.expires_at>?)))`).bind(token,principal,now,now,now).first();
}
export async function notifyBrowsers(env: Env, members: string[]) {
  if (!env.NOTIFICATIONS) return;
  const rows = await env.DB.prepare(`SELECT id FROM principals WHERE active=1 AND
    (kind='owner' OR (kind='human' AND id IN (${members.map(()=>'?').join(',') || 'NULL'})))`).bind(...members).all<{id:string}>();
  await Promise.all(rows.results.map(async person => {
    try { await env.NOTIFICATIONS!.getByName('browser:'+person.id).fetch(new Request('https://notifications/notify',{method:'POST'})); }
    catch { console.warn(JSON.stringify({code:'browser_notification_deferred'})); }
  }));
}

// Socket presence is transport evidence only, never proof of a model turn or ACK.
export async function receiverConnected(env: Env, principal: string): Promise<boolean | null> {
  if (!env.NOTIFICATIONS) return null;
  try {
    const response = await env.NOTIFICATIONS.getByName(principal).fetch(new Request('https://notifications/status'));
    if (!response.ok) return null;
    const status = await response.json<{ state: string }>();
    if (['connected', 'connecting'].includes(status.state)) return true;
    if (['disconnected', 'stale'].includes(status.state)) return false;
    return null;
  } catch { return null; }
}
