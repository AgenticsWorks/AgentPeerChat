import { avatarValue } from './avatar';
import { pairingPublic, pairingOwner } from './pairing';
import type { Env, Message, Principal } from './types';
import { D1MessageStore, IdempotencyConflict } from './store';
import { ApiError, authenticate, body, checkOrigin, equalsSecret, fail, hash, human, id, ids, mintToken, owner, pagination, secret, sessionCookie, str } from './security';

const json = (data: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});
const now = () => new Date().toISOString();

async function findPrincipal(env: Env, principalId: string) {
  const p = await env.DB.prepare('SELECT * FROM principals WHERE id = ?').bind(principalId).first<Principal>();
  if (!p) fail(404, 'not_found', 'Principal not found.');
  return p;
}
async function activePrincipals(env: Env, principalIds: string[]) {
  const { results } = await env.DB.prepare(`SELECT id FROM principals WHERE active = 1 AND id IN (${principalIds.map(() => '?').join(',')})`)
    .bind(...principalIds).all<{ id: string }>();
  if (results.length !== principalIds.length) fail(400, 'invalid_recipient', 'All participants must be active principals.');
}
async function threadAccess(env: Env, threadId: string, principal: Principal) {
  const thread = await env.DB.prepare('SELECT * FROM threads WHERE id = ?').bind(threadId).first();
  if (!thread) fail(404, 'not_found', 'Thread not found.');
  if (principal.kind === 'agent') {
    const member = await env.DB.prepare('SELECT 1 FROM thread_members WHERE thread_id = ? AND principal_id = ?')
      .bind(threadId, principal.id).first();
    if (!member) fail(404, 'not_found', 'Thread not found.');
  }
  return thread;
}
async function threadMembers(env: Env, threadId: string) {
  return (await env.DB.prepare(`SELECT p.* FROM thread_members tm JOIN principals p ON p.id = tm.principal_id
    WHERE tm.thread_id = ? ORDER BY p.created_at, p.id`).bind(threadId).all<Principal>()).results;
}

async function publicRoutes(request: Request, env: Env, path: string) {
  const pairingResponse = await pairingPublic(request, env, path);
  if (pairingResponse) return pairingResponse;
  if (path === '/status' && request.method === 'GET') {
    const initialized = !!await env.DB.prepare("SELECT 1 FROM principals WHERE kind = 'owner'").first();
    return json({ name: 'AgentPeerChat', version: '0.1.6', initialized });
  }
  if (path === '/setup' && request.method === 'POST') {
    const b = await body(request);
    if (!env.SETUP_SECRET || env.SETUP_SECRET.length < 24) fail(503, 'setup_unconfigured', 'Set SETUP_SECRET to at least 24 random characters before initialization.');
    const setupSecret = str(b.setup_secret, 'setup_secret', 512);
    if (!await equalsSecret(setupSecret, env.SETUP_SECRET)) fail(403, 'invalid_setup_secret', 'Incorrect setup secret.');
    const name = str(b.name, 'name', 80), principalId = id('hum'), tokenId = id('tok'), token = secret('agt');
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO principals(id, name, kind) VALUES (?, ?, 'owner')").bind(principalId, name),
        env.DB.prepare("INSERT INTO tokens(id, principal_id, hash, label, kind) VALUES (?, ?, ?, 'Owner recovery key', 'access')")
          .bind(tokenId, principalId, await hash(token))
      ]);
    } catch (error) {
      if (await env.DB.prepare("SELECT 1 FROM principals WHERE kind = 'owner'").first()) fail(409, 'already_initialized', 'This instance already has an owner.');
      throw error;
    }
    return json({ principal: await findPrincipal(env, principalId), access_key: token }, 201);
  }
  if (path === '/session' && request.method === 'POST') {
    checkOrigin(request);
    const b = await body(request), accessKey = str(b.access_key, 'access_key', 256);
    const identity = await authenticate(new Request(request.url, { headers: { Authorization: `Bearer ${accessKey}` } }), env);
    human(identity.principal);
    if (identity.tokenKind !== 'access') fail(403, 'invalid_key_type', 'Use a human access key to sign in.');
    const session = await mintToken(env, identity.principal.id, 'Browser session', 'session', identity.tokenId);
    return json({ principal: identity.principal }, 200, { 'Set-Cookie': sessionCookie(request, session.token) });
  }
  if (path === '/invites/redeem' && request.method === 'POST') {
    const b = await body(request), code = str(b.code, 'code', 256), name = str(b.name, 'name', 80);
    const inviteHash = await hash(code), principalId = id('hum');
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO principals(id, name, kind)
        SELECT ?, ?, 'human' FROM invites WHERE hash = ? AND claimed_by IS NULL AND revoked_at IS NULL AND expires_at > ?`)
        .bind(principalId, name, inviteHash, now()),
      env.DB.prepare(`UPDATE invites SET claimed_by = ? WHERE hash = ? AND claimed_by IS NULL AND revoked_at IS NULL
        AND EXISTS (SELECT 1 FROM principals WHERE id = ?)`).bind(principalId, inviteHash, principalId)
    ]);
    const principal = await env.DB.prepare('SELECT * FROM principals WHERE id = ?').bind(principalId).first<Principal>();
    if (!principal) fail(410, 'invalid_invite', 'Invite is expired, revoked, or already used.');
    const key = await mintToken(env, principal.id, 'Human access key');
    return json({ principal, access_key: key.token }, 201);
  }
  return null;
}

async function api(request: Request, env: Env, url: URL) {
  const path = url.pathname.slice('/api/v1'.length).replace(/\/$/, '') || '/';
  const publicResponse = await publicRoutes(request, env, path);
  if (publicResponse) return publicResponse;
  const identity = await authenticate(request, env), p = identity.principal;
  const pairingResponse = await pairingOwner(request, env, path, p);
  if (pairingResponse) return pairingResponse;
  const store = new D1MessageStore(env.DB), method = request.method;
  if (path === '/me' && method === 'GET') return json({ principal: p });
  if (path === '/me' && method === 'PATCH') {
    if (p.kind !== 'agent') fail(403, 'agent_required', 'Only an Agent may register its own name.');
    const b = await body(request), name = str(b.name, 'name', 80);
    await env.DB.prepare('UPDATE principals SET name = ? WHERE id = ?').bind(name, p.id).run();
    return json({ principal: await findPrincipal(env, p.id) });
  }
  if (path === '/session' && method === 'DELETE') {
    if (identity.tokenKind === 'session') await env.DB.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').bind(now(), identity.tokenId).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', true) });
  }

  if (path === '/principals' && method === 'GET') {
    // Names and IDs are discoverable within the instance; message bodies remain scoped for agents.
    return json({ items: (await env.DB.prepare('SELECT * FROM principals ORDER BY created_at, id LIMIT 200').all()).results });
  }
  if (path === '/agents' && method === 'POST') {
    owner(p);
    const b = await body(request), nameRequired = b.name === undefined || b.name === '';
    const name = nameRequired ? 'Unconnected agent' : str(b.name, 'name', 80);
    const description = b.description === undefined || b.description === '' ? '' : str(b.description, 'description', 500);
    const agentId = id('agt'), tokenId = id('tok'), token = secret('agt');
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM principals').first<{ count: number }>();
    if ((count?.count ?? 0) >= 200) fail(409, 'principal_limit', 'This instance supports up to 200 principals.');
    await env.DB.batch([
      env.DB.prepare("INSERT INTO principals(id, name, kind, description) VALUES (?, ?, 'agent', ?)").bind(agentId, name, description),
      env.DB.prepare("INSERT INTO tokens(id, principal_id, hash, label, kind) VALUES (?, ?, ?, 'Initial agent key', 'access')")
        .bind(tokenId, agentId, await hash(token))
    ]);
    return json({ principal: await findPrincipal(env, agentId), name_required: nameRequired, token: { id: tokenId, token } }, 201);
  }
  let match = /^\/principals\/([^/]+)$/.exec(path);
  if (match && method === 'PATCH') {
    owner(p); const b = await body(request), target = await findPrincipal(env, match[1]);
    const updates: string[] = [], values: (string | number | null)[] = [];
    if (b.active !== undefined) {
      if (target.kind === 'owner') fail(400, 'owner_protected', 'The instance owner cannot be disabled.');
      if (typeof b.active !== 'boolean') fail(400, 'invalid_field', 'active must be a boolean.');
      updates.push('active = ?'); values.push(b.active ? 1 : 0);
    }
    if (b.name !== undefined) { updates.push('name = ?'); values.push(str(b.name, 'name', 80)); }
    if (b.avatar !== undefined) { updates.push('avatar = ?'); values.push(avatarValue(b.avatar)); }
    if (!updates.length) fail(400, 'invalid_field', 'Provide a name, avatar or active state.');
    await env.DB.batch([
      env.DB.prepare('UPDATE principals SET '+updates.join(', ')+' WHERE id = ?').bind(...values, target.id),
      ...(b.active !== false ? [] : [env.DB.prepare("UPDATE pairings SET status = 'rejected' WHERE principal_id = ? AND status IN ('invited','pending')").bind(target.id), env.DB.prepare('UPDATE tokens SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL').bind(now(), target.id)])
    ]);
    return json({ principal: await findPrincipal(env, target.id) });
  }
  if (path === '/tokens' && method === 'GET') {
    human(p);
    return json({ items: (await env.DB.prepare(`SELECT t.id, t.principal_id, t.label, t.kind, t.expires_at, t.revoked_at, t.created_at,
      p.name AS principal_name FROM tokens t JOIN principals p ON p.id = t.principal_id
      WHERE t.kind = 'access' ${p.kind === 'owner' ? '' : 'AND t.principal_id = ?'} ORDER BY t.created_at DESC LIMIT 200`)
      .bind(...(p.kind === 'owner' ? [] : [p.id])).all()).results });
  }
  if (path === '/tokens' && method === 'POST') {
    human(p); const b = await body(request), principalId = b.principal_id === undefined ? p.id : str(b.principal_id, 'principal_id', 80);
    if (principalId !== p.id) owner(p);
    const target = await findPrincipal(env, principalId);
    if (!target.active) fail(400, 'inactive_principal', 'Enable this principal before creating a key.');
    return json({ token: await mintToken(env, principalId, str(b.label, 'label', 80)) }, 201);
  }
  match = /^\/tokens\/([^/]+)$/.exec(path);
  if (match && method === 'DELETE') {
    human(p);
    const token = await env.DB.prepare("SELECT * FROM tokens WHERE id = ? AND kind = 'access'").bind(match[1]).first<{ id: string; principal_id: string }>();
    if (!token) fail(404, 'not_found', 'Key not found.');
    if (token.principal_id !== p.id) owner(p);
    if (token.principal_id === p.id) {
      const keys = await env.DB.prepare("SELECT COUNT(*) AS count FROM tokens WHERE principal_id = ? AND kind = 'access' AND revoked_at IS NULL")
        .bind(p.id).first<{ count: number }>();
      if ((keys?.count ?? 0) <= 1) fail(409, 'last_access_key', 'Create and save a replacement before revoking your last key.');
    }
    const result = await env.DB.prepare(`UPDATE tokens SET revoked_at = ? WHERE (id = ? OR parent_id = ?)
      AND (? != ? OR (SELECT COUNT(*) FROM tokens WHERE principal_id = ? AND kind = 'access' AND revoked_at IS NULL) > 1)`)
      .bind(now(), token.id, token.id, token.principal_id, p.id, p.id).run();
    if (!result.meta.changes) fail(409, 'last_access_key', 'Create and save a replacement before revoking your last key.');
    return json({ ok: true });
  }
  if (path === '/invites' && method === 'GET') {
    owner(p); return json({ items: (await env.DB.prepare('SELECT id, expires_at, claimed_by, revoked_at, created_at FROM invites ORDER BY created_at DESC LIMIT 100').all()).results });
  }
  if (path === '/invites' && method === 'POST') {
    owner(p); const code = secret('agi'), inviteId = id('inv'), expires = new Date(Date.now() + 86400000).toISOString();
    await env.DB.prepare('INSERT INTO invites(id, hash, created_by, expires_at) VALUES (?, ?, ?, ?)').bind(inviteId, await hash(code), p.id, expires).run();
    return json({ invite: { id: inviteId, code, expires_at: expires, url: `${url.origin}/#invite=${code}` } }, 201);
  }
  match = /^\/invites\/([^/]+)$/.exec(path);
  if (match && method === 'DELETE') {
    owner(p);
    const result = await env.DB.prepare('UPDATE invites SET revoked_at = ? WHERE id = ?').bind(now(), match[1]).run();
    if (!result.meta.changes) fail(404, 'not_found', 'Invite not found.');
    return json({ ok: true });
  }

  if (path === '/threads' && method === 'POST') {
    const b = await body(request), recipients = ids(b.members, 'members');
    const members = [...new Set([p.id, ...recipients])];
    await activePrincipals(env, members);
    if (members.length < 2 || members.length > 32) fail(400, 'invalid_members', 'Choose 1–31 other participants.');
    if (b.kind !== undefined && (typeof b.kind !== 'string' || !['direct', 'group'].includes(b.kind))) fail(400, 'invalid_kind', 'Choose direct or group.');
    const direct = b.kind === 'direct';
    if (direct && members.length !== 2) fail(400, 'invalid_members', 'A direct conversation has two participants.');
    const threadId = direct ? `thr_dm_${(await hash([...members].sort().join(':'))).slice(0, 40)}` : id('thr');
    const title = direct ? (await findPrincipal(env, members.find(member => member !== p.id)!)).name : str(b.title, 'title', 120);
    await env.DB.batch([
      env.DB.prepare(`INSERT ${direct ? 'OR IGNORE ' : ''}INTO threads(id, title, created_by, kind) VALUES (?, ?, ?, ?)`).bind(threadId, title, p.id, direct ? 'direct' : 'group'),
      env.DB.prepare(`INSERT ${direct ? 'OR IGNORE ' : ''}INTO thread_members(thread_id, principal_id) VALUES ${members.map(() => '(?, ?)').join(',')}`)
        .bind(...members.flatMap(member => [threadId, member]))
    ]);
    return json({ thread: { ...await threadAccess(env, threadId, p), members: await threadMembers(env, threadId) } }, 201);
  }
  if (path === '/threads' && method === 'GET') {
    const { after, limit } = pagination(url);
    // Thread pagination uses rowid cursors; messages have a separate global sequence.
    const { results } = await env.DB.prepare(`SELECT t.rowid AS cursor, t.*,
      (SELECT COUNT(*) FROM messages mc WHERE mc.thread_id = t.id) AS message_count,
      (SELECT json_group_array(json_object('id', pm.id, 'name', pm.name, 'kind', pm.kind, 'avatar', pm.avatar, 'sent_count', (SELECT COUNT(*) FROM messages sent WHERE sent.thread_id = t.id AND sent.sender_id = pm.id))) FROM thread_members tm JOIN principals pm ON pm.id = tm.principal_id WHERE tm.thread_id = t.id) AS participants,
      (SELECT json_object('type', m.type, 'content', json(m.content), 'sender_id', m.sender_id, 'created_at', m.created_at) FROM messages m WHERE m.seq = t.last_message_seq) AS last_message
      FROM threads t WHERE t.rowid > ? ${p.kind === 'agent' ? 'AND EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = t.id AND tm.principal_id = ?)' : ''}
      ORDER BY t.rowid ASC LIMIT ?`).bind(after, ...(p.kind === 'agent' ? [p.id] : []), limit + 1).all<{ cursor: number; last_message: string | null }>();
    const items = results.slice(0, limit).map(row => ({ ...row, last_message: row.last_message ? JSON.parse(row.last_message) : null, participants: JSON.parse((row as unknown as { participants: string }).participants) }));
    return json({ items, next_cursor: String(items.at(-1)?.cursor ?? after), has_more: results.length > limit });
  }
  match = /^\/threads\/([^/]+)\/members$/.exec(path);
  if (match && method === 'POST') {
    const targetThread = await threadAccess(env, match[1], p);
    if (targetThread.kind === 'direct') fail(400, 'direct_members', 'Create a group to invite more participants.');
    const b = await body(request), added = ids(b.members, 'members');
    await activePrincipals(env, added);
    // Count and insert inside one atomic statement to enforce the cap under concurrent additions.
    const current = await threadMembers(env, match[1]);
    const members = [...new Set([...current.map(m => m.id), ...added])];
    if (members.length > 32) fail(409, 'member_limit', 'Threads support up to 32 participants.');
    const values = added.map(() => '(?)').join(',');
    await env.DB.prepare(`WITH candidates(principal_id) AS (VALUES ${values})
      INSERT OR IGNORE INTO thread_members(thread_id, principal_id)
      SELECT ?, principal_id FROM candidates
      WHERE (SELECT COUNT(*) FROM thread_members WHERE thread_id = ?) +
        (SELECT COUNT(*) FROM candidates WHERE principal_id NOT IN (SELECT principal_id FROM thread_members WHERE thread_id = ?)) <= 32`)
      .bind(...added, match[1], match[1], match[1]).run();
    const actual = await threadMembers(env, match[1]);
    if (added.some(member => !actual.some(m => m.id === member))) fail(409, 'member_limit', 'Threads support up to 32 participants.');
    return json({ members: actual });
  }
  match = /^\/threads\/([^/]+)\/activity$/.exec(path);
  if (match && method === 'GET') {
    await threadAccess(env, match[1], p);
    const { results } = await env.DB.prepare(`WITH recent AS (SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT 20)
      SELECT m.id AS message_id, m.seq, m.sender_id, m.type, m.created_at,
      COALESCE((SELECT json_group_array(json_object('recipient_id', d.recipient_id, 'acked_at', d.acked_at))
        FROM deliveries d WHERE d.message_seq = m.seq), '[]') AS recipients
      FROM recent m ORDER BY m.seq DESC`).bind(match[1]).all<{ recipients: string }>();
    return json({ items: results.map(row => ({ ...row, recipients: JSON.parse(row.recipients) })) });
  }
  match = /^\/threads\/([^/]+)$/.exec(path);
  if (match && method === 'PATCH') {
    const thread = await threadAccess(env, match[1], p);
    if (thread.kind === 'direct') fail(400, 'direct_title', 'Direct chats use participant names.');
    const title = str((await body(request)).title, 'title', 120);
    await env.DB.prepare('UPDATE threads SET title = ? WHERE id = ?').bind(title, match[1]).run();
    return json({ thread: { ...thread, title } });
  }
  if (match && method === 'GET') {
    const thread = await threadAccess(env, match[1], p), { after, limit } = pagination(url);
    const page = await store.listThread(match[1], after, limit);
    return json({ thread: { ...thread, members: await threadMembers(env, match[1]) }, ...page });
  }
  if (path === '/messages' && method === 'POST') {
    const b = await body(request), key = str(request.headers.get('Idempotency-Key'), 'Idempotency-Key', 128);
    const type = str(b.type, 'type', 16) as Message['type'];
    if (!['text', 'json', 'url', 'artifact'].includes(type)) fail(400, 'invalid_type', 'Message type must be text, json, url, or artifact.');
    let content: unknown = b.content;
    if (type === 'text') {
      if (typeof content !== 'string' || !content.trim() || new TextEncoder().encode(content).length > 16384) fail(400, 'invalid_content', 'Text must contain 1–16384 UTF-8 bytes.');
    } else if (type === 'json') {
      if (content === undefined || new TextEncoder().encode(JSON.stringify(content)).length > 32768) fail(400, 'invalid_content', 'JSON content is required and must fit in 32 KiB.');
    } else {
      const value = type === 'artifact' ? (content as { url?: unknown } | null)?.url : content;
      const link = str(value, 'content URL', 2048); let parsed: URL;
      try { parsed = new URL(link); } catch { fail(400, 'invalid_url', 'Provide an absolute HTTP(S) URL.'); }
      if (!['https:', 'http:'].includes(parsed.protocol)) fail(400, 'invalid_url', 'Only HTTP(S) URLs are supported.');
      if (type === 'url') content = link;
      else if (!content || typeof content !== 'object' || Array.isArray(content)) fail(400, 'invalid_content', 'Artifact content must be an object with a url.');
    }
    if (b.thread_id !== undefined && b.to !== undefined) fail(400, 'invalid_destination', 'Use thread_id or to, not both.');
    const destination = b.thread_id !== undefined ? str(b.thread_id, 'thread_id', 80) : ids(b.to, 'to');
    const requestHash = await hash(JSON.stringify({ destination, type, content }));
    // Compare before resolving participants so retries remain valid after an agent is disabled.
    const existing = await env.DB.prepare('SELECT id, request_hash FROM messages WHERE sender_id = ? AND idempotency_key = ?')
      .bind(p.id, key).first<{ id: string; request_hash: string }>();
    if (existing) {
      if (existing.request_hash !== requestHash) fail(409, 'idempotency_conflict', 'This key was already used for a different request.');
      return json({ message: await store.get(existing.id), replayed: true });
    }
    let threadId: string, recipients: string[], newThread: { title: string; members: string[]; kind?: 'group' | 'direct' } | undefined;
    if (typeof destination === 'string') {
      threadId = destination; await threadAccess(env, threadId, p);
      const members = await threadMembers(env, threadId);
      if (!members.some(m => m.id === p.id) && (await threadAccess(env, threadId, p)).kind === 'direct') fail(403, 'direct_observer', 'You can observe this conversation; create a group to join it.');
      if (!members.some(m => m.id === p.id) && members.length >= 32) fail(409, 'member_limit', 'This thread already has 32 participants.');
      recipients = members.filter(m => m.id !== p.id && m.active).map(m => m.id);
      if (!recipients.length) fail(400, 'no_recipients', 'The thread has no other active participants.');
    } else {
      recipients = destination;
      if (recipients.includes(p.id)) fail(400, 'invalid_recipient', 'Send to another principal.');
      if (recipients.length > 31) fail(400, 'member_limit', 'Send to at most 31 other participants.');
      await activePrincipals(env, recipients);
      const members = [p.id, ...recipients];
      const direct = recipients.length === 1;
      threadId = direct ? `thr_dm_${(await hash([...members].sort().join(':'))).slice(0, 40)}` : id('thr');
      newThread = { title: direct ? (await findPrincipal(env, recipients[0])).name : 'New group', members, kind: direct ? 'direct' : 'group' };
    }
    const result = await store.put({ id: id('msg'), thread_id: threadId, sender_id: p.id, type, content,
      idempotency_key: key, request_hash: requestHash, recipients, new_thread: newThread });
    return json(result, result.replayed ? 200 : 201);
  }
  if (path === '/inbox' && method === 'GET') {
    const { after, limit } = pagination(url), include = url.searchParams.get('include_acked');
    if (include !== null && !['0', '1'].includes(include)) fail(400, 'invalid_field', 'include_acked must be 0 or 1.');
    return json(await store.listInbox(p.id, after, limit, include === '1'));
  }
  match = /^\/messages\/([^/]+)(\/ack)?$/.exec(path);
  if (match) {
    if (match[2] && method === 'POST') {
      const ackedAt = await store.ack(match[1], p.id);
      if (!ackedAt) fail(404, 'not_found', 'Message was not delivered to you.');
      return json({ message_id: match[1], acked_at: ackedAt });
    }
    if (!match[2] && method === 'GET') {
      const message = await store.get(match[1]);
      if (!message) fail(404, 'not_found', 'Message not found.');
      await threadAccess(env, message.thread_id, p);
      const receipts = (await env.DB.prepare('SELECT recipient_id, acked_at FROM deliveries WHERE message_seq = ?').bind(message.seq).all()).results;
      return json({ message, receipts });
    }
  }
  if (path === '/overview' && method === 'GET') {
    human(p);
    const { limit } = pagination(url);
    const before = url.searchParams.get('before');
    if (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)) || Number(before) < 1))
      fail(400, 'invalid_cursor', 'before must be a positive safe integer.');
    const status = url.searchParams.get('status') ?? 'all';
    if (!['all', 'pending', 'acked'].includes(status)) fail(400, 'invalid_field', 'status must be all, pending, or acked.');
    const type = url.searchParams.get('type');
    if (type !== null && type !== 'artifact') fail(400, 'invalid_field', 'type must be artifact.');
    const agent = url.searchParams.get('agent');
    if (agent !== null && (await findPrincipal(env, agent)).kind !== 'agent') fail(400, 'invalid_field', 'agent must identify an Agent.');
    const where = [], args: (string | number)[] = [];
    if (before) { where.push('m.seq < ?'); args.push(Number(before)); }
    if (agent) { where.push('(m.sender_id = ? OR EXISTS (SELECT 1 FROM deliveries d WHERE d.message_seq = m.seq AND d.recipient_id = ?))'); args.push(agent, agent); }
    if (type) { where.push('m.type = ?'); args.push(type); }
    const agentDelivery = "SELECT 1 FROM deliveries d JOIN principals r ON r.id = d.recipient_id WHERE d.message_seq = m.seq AND r.kind = 'agent'";
    if (status === 'pending') where.push(`EXISTS (${agentDelivery} AND d.acked_at IS NULL)`);
    if (status === 'acked') where.push(`EXISTS (${agentDelivery}) AND NOT EXISTS (${agentDelivery} AND d.acked_at IS NULL)`);
    const { results } = await env.DB.prepare(`SELECT m.seq, m.id, m.thread_id, m.sender_id, m.type, m.content, m.created_at, t.title AS thread_title,
      (SELECT json_group_array(json_object('recipient_id', d.recipient_id, 'kind', r.kind, 'acked_at', d.acked_at))
        FROM deliveries d JOIN principals r ON r.id = d.recipient_id WHERE d.message_seq = m.seq) AS recipients
      FROM messages m JOIN threads t ON t.id = m.thread_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY m.seq DESC LIMIT ?`).bind(...args, limit + 1).all<Message & { content: string; recipients: string }>();
    const items = results.slice(0, limit).map(m => ({ ...m, content: JSON.parse(m.content), recipients: JSON.parse(m.recipients) }));
    return json({ items, next_cursor: items.length ? String(items.at(-1)!.seq) : null, has_more: results.length > limit });
  }
  if (path === '/export' && method === 'GET') {
    owner(p);
    // Paged JSON export of message history; credentials and secrets are never exported.
    const { after, limit } = pagination(url);
    const { results } = await env.DB.prepare('SELECT seq, id, thread_id, sender_id, type, content, created_at FROM messages WHERE seq > ? ORDER BY seq LIMIT ?')
      .bind(after, limit + 1).all<Message & { content: string }>();
    const items = results.slice(0, limit).map(m => ({ ...m, content: JSON.parse(m.content) }));
    return json({ items, next_cursor: String(items.at(-1)?.seq ?? after), has_more: results.length > limit });
  }
  fail(404, 'not_found', 'API endpoint not found.');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    let response: Response;
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1' || url.pathname.startsWith('/api/v1/')) response = await api(request, env, url);
      else if (url.pathname.startsWith('/api/')) response = json({ error: { code: 'not_found', message: 'Use /api/v1.', request_id: requestId } }, 404);
      else response = await env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof IdempotencyConflict) response = json({ error: { code: 'idempotency_conflict', message: 'This key was used for a different request.', request_id: requestId } }, 409);
      else if (error instanceof ApiError) response = json({ error: { code: error.code, message: error.message, request_id: requestId } }, error.status);
      else if (error instanceof Error && error.message.includes('agentgram_member_limit')) {
        response = json({ error: { code: 'member_limit', message: 'Threads support up to 32 participants.', request_id: requestId } }, 409);
      } else if (error instanceof Error && error.message.includes('agentgram_principal_limit')) {
        response = json({ error: { code: 'principal_limit', message: 'This instance supports up to 200 principals.', request_id: requestId } }, 409);
      } else {
        // Do not log payloads, credentials, or binding error text that may contain SQL values.
        console.error(JSON.stringify({ request_id: requestId, code: 'storage_or_internal_error' }));
        response = json({ error: { code: 'temporarily_unavailable', message: 'Storage is unavailable. Retry with backoff; check database availability, migrations and hosting quotas.', request_id: requestId } }, 503, { 'Retry-After': '60' });
      }
    }
    const headers = new Headers(response.headers);
    headers.set('X-Request-Id', requestId);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
} satisfies ExportedHandler<Env>;
