import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf, db, ownerKey, ownerId, a, b, c;
const setup = 'local-test-setup-secret-with-32-bytes';
const origin = 'https://agent-gram.test';
async function call(path, { method = 'GET', key = ownerKey, body, idempotency, cookie, extra = {} } = {}) {
  const response = await mf.dispatchFetch(`${origin}/api/v1${path}`, {
    method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(idempotency ? { 'Idempotency-Key': idempotency } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
before(async () => {
  const bundled = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'agent-gram', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-10-02',
    d1Databases: { DB: 'test-database' }, bindings: { SETUP_SECRET: setup },
    serviceBindings: { ASSETS: async () => new Response('static assets') } }] }));
  db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = await readFile(`migrations/${file}`, 'utf8');
    // Preserve SQL trigger bodies; do not split statements naively at semicolons.
    await db.exec(sql.replaceAll('\n', ' '));
  }
});
after(async () => { await mf?.dispose(); });

test('setup secret is required; concurrent initialization produces exactly one owner', async () => {
  const status = await call('/status', { key: null }); assert.equal(status.data.initialized, false);
  assert.equal((await call('/setup', { method: 'POST', key: null, body: { name: 'Operator', setup_secret: 'wrong' } })).status, 403);
  const results = await Promise.all([1, 2].map(() => call('/setup', { method: 'POST', key: null, body: { name: 'Operator', setup_secret: setup } })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const result = results.find(r => r.status === 201); ownerKey = result.data.access_key; ownerId = result.data.principal.id;
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM principals WHERE kind = 'owner'").first()).n, 1);
  assert.equal((await call('/status', { key: null })).data.initialized, true);
  assert.equal((await call('/me', { key: 'invalid' })).status, 401);
});

test('owner creates agents; tokens are stored hashed and agent cannot administer', async () => {
  const created = [];
  for (const name of ['Planner', 'Builder', 'Reviewer']) {
    const result = await call('/agents', { method: 'POST', body: { name, description: `${name} agent` } });
    assert.equal(result.status, 201); created.push({ id: result.data.principal.id, key: result.data.token.token, tokenId: result.data.token.id });
    const token = await db.prepare('SELECT hash FROM tokens WHERE id = ?').bind(result.data.token.id).first();
    assert.notEqual(token.hash, result.data.token.token); assert.equal(token.hash.length, 64);
  }
  [a, b, c] = created;
  assert.equal((await call('/agents', { method: 'POST', key: a.key, body: { name: 'Uninvited' } })).status, 403);
  assert.equal((await call('/tokens', { key: a.key })).status, 403);
});

let groupId, firstMessage;
test('agent proactively creates a group; unrelated agent is isolated; owner observes all', async () => {
  const group = await call('/threads', { method: 'POST', key: a.key, body: { title: 'Release plan', members: [b.id] } });
  assert.equal(group.status, 201); groupId = group.data.thread.id;
  assert.deepEqual(group.data.thread.members.map(p => p.id).sort(), [a.id, b.id].sort());
  assert.equal((await call(`/threads/${groupId}`, { key: c.key })).status, 404);
  assert.equal((await call('/threads', { key: c.key })).data.items.length, 0);
  assert.equal((await call(`/threads/${groupId}`)).status, 200);
  const sent = await call('/messages', { method: 'POST', key: a.key, idempotency: 'handoff-1', body: { thread_id: groupId, type: 'text', content: 'Build the release.' } });
  assert.equal(sent.status, 201); firstMessage = sent.data.message;
  assert.equal((await call(`/messages/${firstMessage.id}`, { key: c.key })).status, 404);
  assert.equal((await call(`/messages/${firstMessage.id}`)).data.receipts[0].recipient_id, b.id);
  assert.equal((await call(`/messages/${firstMessage.id}/ack`, { method: 'POST', key: a.key })).status, 404);
});

test('idempotency survives retries, rejects changed payload, and concurrent direct sends create one thread', async () => {
  const body = { thread_id: groupId, type: 'text', content: 'Build the release.' };
  const replay = await call('/messages', { method: 'POST', key: a.key, idempotency: 'handoff-1', body });
  assert.equal(replay.status, 200); assert.equal(replay.data.message.id, firstMessage.id); assert.equal(replay.data.replayed, true);
  assert.equal((await call('/messages', { method: 'POST', key: a.key, idempotency: 'handoff-1', body: { ...body, content: 'Changed' } })).status, 409);
  const direct = { to: [c.id], type: 'json', content: { task: 'review', files: ['src/index.ts'] } };
  const results = await Promise.all(Array.from({ length: 5 }, () => call('/messages', { method: 'POST', key: a.key, idempotency: 'concurrent-direct', body: direct })));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(new Set(results.map(r => r.data.message.id)).size, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM threads').first()).n, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE idempotency_key = 'concurrent-direct'").first()).n, 1);
});

test('inbox cursor and ack are separate; unacked messages can be replayed and ack is idempotent', async () => {
  const inbox = await call('/inbox?after=0&limit=1', { key: b.key });
  assert.equal(inbox.data.items[0].id, firstMessage.id); assert.equal(inbox.data.next_cursor, String(firstMessage.seq));
  assert.equal((await call(`/inbox?after=${inbox.data.next_cursor}`, { key: b.key })).data.items.length, 0);
  assert.equal((await call('/inbox?after=0', { key: b.key })).data.items.length, 1);
  const ack = await call(`/messages/${firstMessage.id}/ack`, { method: 'POST', key: b.key });
  const again = await call(`/messages/${firstMessage.id}/ack`, { method: 'POST', key: b.key });
  assert.equal(ack.status, 200); assert.equal(ack.data.acked_at, again.data.acked_at);
  assert.equal((await call('/inbox', { key: b.key })).data.items.length, 0);
  assert.equal((await call('/inbox?include_acked=1', { key: b.key })).data.items[0].acked_at, ack.data.acked_at);
  assert.equal((await call(`/threads/${groupId}`)).data.items[0].id, firstMessage.id);
  const activity = await call(`/threads/${groupId}/activity`);
  assert.equal(activity.data.items[0].recipients[0].acked_at, ack.data.acked_at);
});

test('agent adds members; new members read history, future delivery fanout is exact', async () => {
  const added = await call(`/threads/${groupId}/members`, { method: 'POST', key: a.key, body: { members: [c.id] } });
  assert.equal(added.status, 200);
  assert.equal((await call(`/threads/${groupId}`, { key: c.key })).data.items[0].id, firstMessage.id);
  const result = await call('/messages', { method: 'POST', key: b.key, idempotency: 'builder-artifact', body: { thread_id: groupId, type: 'artifact', content: { url: 'https://example.com/release', name: 'Release candidate' } } });
  assert.equal(result.status, 201);
  const receipts = (await call(`/messages/${result.data.message.id}`)).data.receipts;
  assert.deepEqual(receipts.map(r => r.recipient_id).sort(), [a.id, c.id].sort());
  const humanSent = await call('/messages', { method: 'POST', idempotency: 'human-review', body: { thread_id: groupId, type: 'text', content: 'Please add accessibility checks.' } });
  assert.equal(humanSent.status, 201);
  assert.equal((await call(`/threads/${groupId}`)).data.thread.members.length, 4);
});

let humanKey, humanId;
test('one-time human invite can be redeemed once under concurrency; humans observe and participate', async () => {
  const invite = await call('/invites', { method: 'POST', body: {} });
  assert.equal(invite.status, 201);
  assert.equal((await call('/invites', { key: a.key })).status, 403);
  const results = await Promise.all([1, 2].map(() => call('/invites/redeem', { method: 'POST', key: null, body: { code: invite.data.invite.code, name: 'Teammate' } })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 410]);
  const accepted = results.find(r => r.status === 201); humanKey = accepted.data.access_key; humanId = accepted.data.principal.id;
  assert.equal((await call(`/threads/${groupId}`, { key: humanKey })).status, 200);
  assert.equal((await call('/agents', { method: 'POST', key: humanKey, body: { name: 'No permission' } })).status, 403);
  assert.equal((await call('/tokens', { method: 'POST', key: humanKey, body: { principal_id: a.id, label: 'steal' } })).status, 403);
  const sent = await call('/messages', { method: 'POST', key: humanKey, idempotency: 'teammate-comment', body: { thread_id: groupId, type: 'text', content: 'I can help with the launch.' } });
  assert.equal(sent.status, 201); assert.equal(sent.data.message.sender_id, humanId);
});

test('browser session is HttpOnly and Secure; CSRF rejected; key revocation invalidates child sessions', async () => {
  const login = await call('/session', { method: 'POST', key: null, extra: { Origin: origin }, body: { access_key: humanKey } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('Set-Cookie'); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Strict/);
  assert.equal((await call('/me', { key: null, cookie })).status, 200);
  assert.equal((await call('/threads', { method: 'POST', key: null, cookie, body: { title: 'CSRF', members: [a.id] } })).status, 403);
  assert.equal((await call('/threads', { method: 'POST', key: null, cookie, extra: { Origin: 'https://evil.test' }, body: { title: 'CSRF', members: [a.id] } })).status, 403);
  assert.equal((await call('/threads', { method: 'POST', key: null, cookie, extra: { Origin: origin }, body: { title: 'Browser conversation', members: [a.id] } })).status, 201);
  const tokens = await call('/tokens', { key: humanKey }); const old = tokens.data.items.find(t => !t.revoked_at);
  assert.equal((await call(`/tokens/${old.id}`, { method: 'DELETE', key: humanKey })).status, 409);
  await call('/tokens', { method: 'POST', key: humanKey, body: { label: 'Replacement' } });
  assert.equal((await call(`/tokens/${old.id}`, { method: 'DELETE', key: humanKey })).status, 200);
  assert.equal((await call('/me', { key: null, cookie })).status, 401);
  assert.equal((await call('/me', { key: humanKey })).status, 401);
  assert.equal((await call('/session', { method: 'POST', key: null, extra: { Origin: origin }, body: { access_key: a.key } })).status, 403);
});

test('validation, safe errors, pagination, and export', async () => {
  for (const after of ['-1', 'abc', '9007199254740992']) assert.equal((await call(`/inbox?after=${after}`)).status, 400);
  for (const limit of ['0', '101', 'abc']) assert.equal((await call(`/threads?limit=${limit}`)).status, 400);
  assert.equal((await call('/messages', { method: 'POST', body: { to: [a.id], type: 'text', content: 'no key' } })).status, 400);
  assert.equal((await call('/messages', { method: 'POST', idempotency: 'bad-url', body: { to: [a.id], type: 'url', content: 'javascript:alert(1)' } })).status, 400);
  assert.equal((await call('/messages', { method: 'POST', idempotency: 'too-large', body: { to: [a.id], type: 'text', content: '字'.repeat(6000) } })).status, 400);
  assert.equal((await call('/agents', { method: 'POST', body: { name: 'x'.repeat(70000) } })).status, 413);
  const exported = await call('/export?limit=1'); assert.equal(exported.status, 200); assert.equal(exported.data.has_more, true);
  assert.equal(exported.data.items[0].id, firstMessage.id); assert.equal(exported.data.items[0].request_hash, undefined);
  assert.equal((await call('/export', { key: a.key })).status, 403);
  const missing = await call('/not-found'); assert.equal(missing.status, 404); assert.ok(missing.data.error.request_id);
  assert.match(missing.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
});

test('disabled principals lose access; re-enabling requires fresh key and history remains', async () => {
  assert.equal((await call(`/principals/${ownerId}`, { method: 'PATCH', body: { active: false } })).status, 400);
  assert.equal((await call(`/principals/${c.id}`, { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await call('/me', { key: c.key })).status, 401);
  assert.equal((await call(`/principals/${c.id}`, { method: 'PATCH', body: { active: true } })).status, 200);
  assert.equal((await call('/me', { key: c.key })).status, 401);
  const key = await call('/tokens', { method: 'POST', body: { principal_id: c.id, label: 'Reenabled key' } });
  assert.equal((await call(`/threads/${groupId}`, { key: key.data.token.token })).status, 200);
  assert.ok((await call(`/threads/${groupId}`)).data.items.length >= 4);
});

test('maximum-size direct groups are atomic; concurrent observer joins cannot exceed 32 members', async () => {
  const extra = Array.from({ length: 33 }, (_, n) => ({ id: `edge_${n}`, name: `Edge ${n}` }));
  await db.batch(extra.map(p => db.prepare("INSERT INTO principals(id, name, kind) VALUES (?, ?, 'human')").bind(p.id, p.name)));
  const full = await call('/messages', { method: 'POST', idempotency: 'full-direct', body: { to: extra.slice(0, 31).map(p => p.id), type: 'text', content: 'A maximum-size group message.' } });
  assert.equal(full.status, 201);
  assert.equal((await call(`/threads/${full.data.message.thread_id}`)).data.thread.members.length, 32);
  assert.equal((await call(`/messages/${full.data.message.id}`)).data.receipts.length, 31);
  const edge = await call('/threads', { method: 'POST', body: { title: 'Concurrent joins', members: extra.slice(0, 30).map(p => p.id) } });
  const keys = [];
  for (const p of extra.slice(31)) keys.push((await call('/tokens', { method: 'POST', body: { principal_id: p.id, label: 'Edge test' } })).data.token.token);
  const results = await Promise.all(keys.map((key, i) => call('/messages', { method: 'POST', key, idempotency: `join-${i}`, body: { thread_id: edge.data.thread.id, type: 'text', content: 'Joining this observed group.' } })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  const actual = await call(`/threads/${edge.data.thread.id}`);
  assert.equal(actual.data.thread.members.length, 32); assert.equal(actual.data.items.length, 1);
  assert.equal(actual.data.thread.message_count, 1);
});

test('concurrent key revocations leave one working owner recovery key', async () => {
  const existing = (await call('/tokens')).data.items.find(t => t.principal_id === ownerId && !t.revoked_at);
  const replacement = (await call('/tokens', { method: 'POST', body: { label: 'Concurrent recovery' } })).data.token;
  const results = await Promise.all([existing.id, replacement.id].map(tokenId => call(`/tokens/${tokenId}`, { method: 'DELETE' })));
  assert.equal(results.filter(r => r.status === 200).length, 1);
  // A request whose bearer key was just revoked may fail auth before it reaches final-key protection.
  assert.ok(results.every(r => [200, 401, 409].includes(r.status)));
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE principal_id = ? AND kind = 'access' AND revoked_at IS NULL").bind(ownerId).first()).n, 1);
  const originalWorks = (await call('/me')).status === 200;
  if (!originalWorks) ownerKey = replacement.token;
  assert.equal((await call('/me')).status, 200);
});

test('principal cap is enforced atomically, so the directory never silently truncates new identities', async () => {
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM principals').first()).n;
  const statements = Array.from({ length: 199 - count }, (_, n) => db.prepare("INSERT INTO principals(id, name, kind) VALUES (?, ?, 'agent')").bind(`cap_${n}`, `Capacity ${n}`));
  await db.batch(statements);
  const results = await Promise.all([1, 2].map(i => call('/agents', { method: 'POST', body: { name: `Last ${i}` } })));
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal((await call('/principals')).data.items.length, 200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM principals').first()).n, 200);
});
