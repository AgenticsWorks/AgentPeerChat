import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf, db, ownerKey, ownerId, a, b, c;
const setup = 'local-test-setup-secret-with-32-bytes';
const origin = 'https://agentpeerchat.test';
async function call(path, { method = 'GET', key = ownerKey, body, idempotency, cookie, extra = {} } = {}) {
  if(path==='/pairings'&&method==='POST')body={approval_required:true,...body};
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
  if (process.env.AGENTPEERCHAT_TEST_BACKEND === 'sqlite') {
    const { SQLiteDatabase } = await import('../server/sqlite.mjs');
    const worker = (await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))).default;
    db = new SQLiteDatabase(':memory:');
    mf = { dispatchFetch: (url, options) => worker.fetch(new Request(url, options), { DB: db, SETUP_SECRET: setup, ASSETS: { fetch: async () => new Response('static assets') } }), getD1Database: async () => db, dispose: async () => db.close() };
  } else mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'agentpeerchat', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-10-02',
    d1Databases: { DB: 'test-database', MIGRATION_DB: 'migration-test-database' }, bindings: { SETUP_SECRET: setup },
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
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(status.data.version, version, '/status must report the package version');
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

test('owner can edit names and avatar presets without changing access; image validation rejects unsafe formats',async()=>{
 const p=(await call('/pairings',{method:'POST',body:{name:'Icon agent',avatar:'preset:dots'}})).data.principal;
 assert.equal(p.avatar,'preset:dots');
 const updated=await call(`/principals/${p.id}`,{method:'PATCH',body:{name:'Renamed agent',avatar:'preset:muse'}});
 assert.equal(updated.status,200);assert.equal(updated.data.principal.name,'Renamed agent');assert.equal(updated.data.principal.avatar,'preset:muse');assert.equal(updated.data.principal.active,0);
 for(const avatar of ['data:image/svg+xml;base64,PHN2Zy8+','https://example.com/image.png','data:image/png;base64,bm90YW5pbWFnZQ=='])assert.equal((await call(`/principals/${p.id}`,{method:'PATCH',body:{avatar}})).status,400);
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1AAAAABJRU5ErkJggg==';
 assert.equal((await call(`/principals/${p.id}`,{method:'PATCH',body:{avatar:png}})).status,200);
 assert.equal((await call(`/principals/${ownerId}`,{method:'PATCH',body:{avatar:'preset:dots'}})).status,200);
 assert.equal((await call(`/principals/${ownerId}`,{method:'PATCH',body:{active:false}})).status,400);
 const agent=(await call('/agents',{method:'POST',body:{name:'Avatar isolation'}})).data;
 assert.equal((await call(`/principals/${p.id}`,{method:'PATCH',key:agent.token.token,body:{name:'Unauthorized'}})).status,403);
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
  const stats=(await call('/threads',{key:a.key})).data.items.find(thread=>thread.id===groupId);
  assert.equal(stats.message_count,1);
  assert.equal(stats.participants.find(person=>person.id===a.id).sent_count,1);
  assert.equal(stats.participants.find(person=>person.id===b.id).sent_count,0);
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
test('human overview spans groups, paginates newest first and distinguishes Agent processing from human ack', async () => {
  const group = (await call('/threads', { method: 'POST', key: a.key, body: { title: 'Overview isolation', members: [b.id, ownerId] } })).data.thread;
  const sent = await call('/messages', { method: 'POST', key: a.key, idempotency: 'overview-status', body: { thread_id: group.id, type: 'text', content: '<script>Private fixture</script>' } });
  const message = sent.data.message;
  assert.equal((await call('/overview', { key: a.key })).status, 403);
  assert.equal((await call('/overview', { key: c.key })).status, 403);
  assert.equal((await call('/overview', { key: null })).status, 401);
  const pending = (await call(`/overview?agent=${b.id}&status=pending`)).data.items.find(m => m.id === message.id);
  assert.equal(pending.thread_title, 'Overview isolation'); assert.equal(pending.content, '<script>Private fixture</script>');
  assert.deepEqual(pending.recipients.map(r => r.kind).sort(), ['agent', 'owner']);
  await call(`/messages/${message.id}/ack`, { method: 'POST', key: b.key });
  assert.ok(!(await call(`/overview?agent=${b.id}&status=pending`)).data.items.some(m => m.id === message.id));
  const acked = (await call(`/overview?agent=${b.id}&status=acked`)).data.items.find(m => m.id === message.id);
  assert.ok(acked.recipients.find(r => r.recipient_id === b.id).acked_at);
  assert.equal(acked.recipients.find(r => r.recipient_id === ownerId).acked_at, null);
  const first = await call('/overview?limit=1'); assert.equal(first.data.items.length, 1); assert.equal(first.data.has_more, true);
  const next = await call(`/overview?limit=1&before=${first.data.next_cursor}`);
  assert.ok(next.data.items[0].seq < first.data.items[0].seq);
  const artifacts = await call('/overview?type=artifact'); assert.ok(artifacts.data.items.length); assert.ok(artifacts.data.items.every(m => m.type === 'artifact'));
  for (const query of ['before=-1', 'before=0', 'before=9007199254740992', 'status=done', 'type=text', `agent=${ownerId}`]) assert.equal((await call(`/overview?${query}`)).status, 400);
});

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

test('direct chats reuse a single thread across sender changes and distinct send keys; observers cannot join a private pair', async () => {
  const first = await call('/threads', { method: 'POST', body: { kind: 'direct', members: [a.id] } }); assert.equal(first.status, 201);
  const reverse = await call('/threads', { method: 'POST', key: a.key, body: { kind: 'direct', members: [ownerId] } }); assert.equal(reverse.data.thread.id, first.data.thread.id);
  const messages = await Promise.all([1, 2].map(n => call('/messages', { method: 'POST', idempotency: `distinct-direct-${n}`, body: { to: [a.id], type: 'text', content: `Message ${n}` } })));
  assert.ok(messages.every(m => m.data.message.thread_id === first.data.thread.id));
  const thread = (await call('/threads')).data.items.find(t => t.id === first.data.thread.id);
  assert.equal(thread.kind, 'direct'); assert.equal(thread.participants.length, 2);
  const pair = await call('/threads', { method: 'POST', key: a.key, body: { kind: 'direct', members: [b.id] } });
  assert.equal((await call(`/threads/${pair.data.thread.id}`)).status, 200);
  assert.equal((await call('/messages', { method: 'POST', idempotency: 'observer-private', body: { thread_id: pair.data.thread.id, type: 'text', content: 'Joining' } })).status, 403);
  assert.equal((await call(`/threads/${pair.data.thread.id}/members`, { method: 'POST', key: a.key, body: { members: [ownerId] } })).status, 400);
});

test('owner connects an unnamed Agent; Agent registers only its own name', async () => {
  const created = await call('/agents', {method:'POST',body:{}});
  assert.equal(created.status,201);assert.equal(created.data.name_required,true);
  const key=created.data.token.token, agentId=created.data.principal.id;
  assert.equal((await call('/me',{method:'PATCH',key,body:{name:'资料员'}})).data.principal.name,'资料员');
  assert.equal((await call('/principals/'+a.id,{method:'PATCH',key,body:{name:'冒名'}})).status,403);
  assert.equal((await call('/me',{method:'PATCH',key,body:{name:''}})).status,400);
  assert.equal((await call('/me',{method:'PATCH',body:{name:'改拥有者'}})).status,403);
  assert.equal((await call('/me',{key})).data.principal.id,agentId);
});

test('pairing requires an authorized invitation and approval; candidate proof has no access beforehand', async () => {
  assert.equal((await call('/pairings', {method:'POST',key:null,body:{}})).status,401);
  assert.equal((await call('/pairings', {method:'POST',key:a.key,body:{}})).status,201);
  const issued=await call('/pairings',{method:'POST',body:{name:'Paired device'}});assert.equal(issued.status,201);
  const invitation=issued.data.pairing,token='agt_'+crypto.randomUUID().replaceAll('-','');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token));
  const tokenHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  assert.equal(issued.data.principal.active,0);assert.equal(issued.data.token,undefined);
  assert.equal((await call('/pairings/request',{method:'POST',key:null,body:{code:'wrong',token_hash:tokenHash}})).status,410);
  const requested=await call('/pairings/request',{method:'POST',key:null,body:{code:invitation.code,token_hash:tokenHash}});assert.equal(requested.status,200);
  assert.match(requested.data.pairing.verification_code,/^[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal((await call('/pairings/request',{method:'POST',key:null,body:{code:invitation.code,token_hash:'0'.repeat(64)}})).status,410);
  assert.equal((await call('/me',{key:token})).status,401);
  assert.equal((await call('/inbox',{key:token})).status,401);
  assert.equal((await call('/threads',{key:null})).status,401);
  const listed=await call('/pairings');assert.ok(listed.data.items.some(p=>p.id===invitation.id));assert.ok(!JSON.stringify(listed.data).includes(tokenHash));
  assert.equal((await call(`/pairings/${invitation.id}/check`,{method:'POST',key:null,body:{token:'wrong'}})).status,410);
  assert.equal((await call(`/pairings/${invitation.id}/approve`,{method:'POST',key:a.key,body:{verification_code:requested.data.pairing.verification_code}})).status,404);
  assert.equal((await call(`/pairings/${invitation.id}/approve`,{method:'POST',body:{verification_code:'0000-0000'}})).status,400);
  assert.equal((await call(`/pairings/${invitation.id}/approve`,{method:'POST',body:{verification_code:requested.data.pairing.verification_code}})).status,200);
  assert.equal((await call('/me',{key:token})).data.principal.id,issued.data.principal.id);
  const checked=await call(`/pairings/${invitation.id}/check`,{method:'POST',key:null,body:{token}});assert.equal(checked.data.pairing.status,'approved');
  const saved=await db.prepare('SELECT hash FROM tokens WHERE id = ?').bind(checked.data.token_id).first();assert.equal(saved.hash,tokenHash);
  await call(`/tokens/${checked.data.token_id}`,{method:'DELETE'});assert.equal((await call('/me',{key:token})).status,401);
});

test('pairing invitation is bounded, single-device, retryable, and denied on expiry/rejection/disable', async () => {
  const issue=async()=> (await call('/pairings',{method:'POST',body:{principal_id:a.id}})).data.pairing;
  let invitation=await issue();
  const hashes=['1'.repeat(64),'2'.repeat(64)];
  const competed=await Promise.all(hashes.map(token_hash=>call('/pairings/request',{method:'POST',key:null,body:{code:invitation.code,token_hash}})));
  assert.deepEqual(competed.map(r=>r.status).sort(),[200,410]);
  const winner=competed.findIndex(r=>r.status===200);
  assert.equal((await call('/pairings/request',{method:'POST',key:null,body:{code:invitation.code,token_hash:hashes[winner]}})).status,200);
  assert.equal((await call(`/pairings/${invitation.id}/reject`,{method:'POST',body:{}})).status,200);
  assert.equal((await call('/pairings/request',{method:'POST',key:null,body:{code:invitation.code,token_hash:hashes[winner]}})).status,410);
  invitation=await issue();await db.prepare('UPDATE pairings SET expires_at = ? WHERE id = ?').bind('2000-01-01T00:00:00Z',invitation.id).run();
  assert.equal((await call('/pairings/request',{method:'POST',key:null,body:{code:invitation.code,token_hash:hashes[0]}})).status,410);
  assert.equal((await call(`/pairings/${invitation.id}/approve`,{method:'POST',body:{verification_code:'0000-0000'}})).status,410);
  invitation=await issue();
  const pending=await call('/pairings/request',{method:'POST',key:null,body:{code:invitation.code,token_hash:hashes[0]}});
  await call(`/principals/${a.id}`,{method:'PATCH',body:{active:false}});
  assert.equal((await call(`/pairings/${invitation.id}/approve`,{method:'POST',body:{verification_code:pending.data.pairing.verification_code}})).status,409);
  await call(`/principals/${a.id}`,{method:'PATCH',body:{active:true}});
});

test('Agent probe is private, cheap to poll, and detects membership in older empty threads', async () => {
  const created = (await call('/agents', { method: 'POST', body: { name: 'Probe reader' } })).data;
  const agentId = created.principal.id, key = created.token.token;
  const probe = async () => {
    const response = await call('/probe', { key });
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.data).sort(), ['agent', 'membership_cursor', 'pending']);
    assert.deepEqual(Object.keys(response.data.agent).sort(), ['id', 'name']);
    return response.data;
  };
  assert.deepEqual(await probe(), { agent: { id: agentId, name: 'Probe reader' }, pending: false, membership_cursor: '0' });
  const plan = await db.prepare('EXPLAIN QUERY PLAN SELECT MAX(rowid) FROM thread_members WHERE principal_id = ?').bind(agentId).all();
  assert.ok(plan.results.some(row => /USING COVERING INDEX members_principal_latest/.test(row.detail)), 'migration enables indexed newest-membership lookup');
  assert.equal((await call('/probe', { key: null })).status, 401);
  assert.equal((await call('/probe', { key: 'invalid' })).status, 401);
  assert.equal((await call('/probe')).status, 403);
  const human = (await call('/tokens', { method: 'POST', body: { principal_id: humanId, label: 'Probe human' } })).data.token.token;
  assert.equal((await call('/probe', { key: human })).status, 403);

  const older = (await call('/threads', { method: 'POST', body: { title: 'Older empty group', members: [b.id] } })).data.thread;
  assert.equal((await probe()).membership_cursor, '0', 'other principals cannot change this Agent’s membership cursor');
  const newer = (await call('/threads', { method: 'POST', body: { title: 'New empty group', members: [agentId] } })).data.thread;
  const initial = await probe();
  assert.equal(initial.pending, false);
  assert.notEqual(initial.membership_cursor, '0', 'an empty thread still changes membership');
  await call(`/threads/${older.id}/members`, { method: 'POST', body: { members: [agentId] } });
  const added = await probe();
  assert.ok(BigInt(added.membership_cursor) > BigInt(initial.membership_cursor), 'joining an old thread must invalidate cached membership');
  await call(`/threads/${older.id}/members`, { method: 'POST', body: { members: [agentId] } });
  assert.equal((await probe()).membership_cursor, added.membership_cursor, 'idempotent membership inserts do not invalidate the cursor');
  const sent = await call('/messages', { method: 'POST', idempotency: 'probe-pending', body: { thread_id: newer.id, type: 'text', content: 'Pending until acknowledged.' } });
  assert.equal(sent.status, 201);
  assert.equal((await probe()).pending, true);
  assert.equal((await probe()).membership_cursor, added.membership_cursor, 'message activity is not membership activity');
  await call(`/messages/${sent.data.message.id}/ack`, { method: 'POST', key });
  assert.equal((await probe()).pending, false, 'the last acknowledgment clears pending');
  await call('/me', { method: 'PATCH', key, body: { name: 'Renamed probe reader' } });
  assert.equal((await probe()).agent.name, 'Renamed probe reader');
  const replacement = (await call('/tokens', { method: 'POST', body: { principal_id: agentId, label: 'Probe replacement' } })).data.token;
  await call(`/tokens/${created.token.id}`, { method: 'DELETE' });
  assert.equal((await call('/probe', { key })).status, 401, 'revoked credentials never return a successful idle result');
  assert.equal((await call('/probe', { key: replacement.token })).status, 200);
  await call(`/principals/${agentId}`, { method: 'PATCH', body: { active: false } });
  assert.equal((await call('/probe', { key: replacement.token })).status, 401);
});

test('inbox and thread pages preserve every message beyond 100 items with identical timestamps', async () => {
  const created = (await call('/agents', { method: 'POST', body: { name: 'Paged reader' } })).data;
  const key = created.token.token;
  const thread = (await call('/threads', { method: 'POST', body: { title: 'Sequence pagination', members: [created.principal.id] } })).data.thread;
  const sent = [];
  for (let i = 0; i < 105; i++) {
    const response = await call('/messages', { method: 'POST', idempotency: `same-time-page-${i}`, body: { thread_id: thread.id, type: 'text', content: `Message ${i}` } });
    assert.equal(response.status, 201);
    sent.push(response.data.message);
  }
  await db.prepare('UPDATE messages SET created_at = ? WHERE thread_id = ?').bind('2026-01-01T00:00:00.000Z', thread.id).run();
  for (const path of ['/inbox', `/threads/${thread.id}`]) {
    const first = (await call(`${path}?limit=100`, { key })).data;
    assert.equal(first.items.length, 100);
    assert.equal(first.has_more, true);
    assert.equal(first.next_cursor, String(first.items.at(-1).seq));
    const second = (await call(`${path}?limit=100&after=${first.next_cursor}`, { key })).data;
    assert.equal(second.items.length, 5);
    assert.equal(second.has_more, false);
    assert.equal(second.next_cursor, String(second.items.at(-1).seq));
    assert.deepEqual([...first.items, ...second.items].map(m => m.id), sent.map(m => m.id));
    assert.equal(new Set([...first.items, ...second.items].map(m => m.created_at)).size, 1);
    const empty = (await call(`${path}?limit=100&after=${second.next_cursor}`, { key })).data;
    assert.deepEqual(empty, { ...(empty.thread ? { thread: empty.thread } : {}), items: [], next_cursor: second.next_cursor, has_more: false });
    assert.equal((await call(`${path}?limit=101`, { key })).status, 400);
  }
});

test('maximum legal UTF-8 messages continue across byte-bounded inbox and history pages', async () => {
  const created = (await call('/agents', { method: 'POST', body: { name: 'Large-page reader' } })).data;
  const key = created.token.token;
  const thread = (await call('/threads', { method: 'POST', body: { title: 'Byte pagination', members: [created.principal.id] } })).data.thread;
  const body = { thread_id: thread.id, type: 'artifact', content: { url: 'https://example.com/large', payload: '' } };
  const available = 65536 - Buffer.byteLength(JSON.stringify(body));
  body.content.payload = '界'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
  assert.equal(Buffer.byteLength(JSON.stringify(body)), 65536, 'fixture reaches the legal request byte ceiling');
  const sent = [];
  for (let i = 0; i < 6; i++) {
    const response = await call('/messages', { method: 'POST', idempotency: `large-page-${i}`, body });
    assert.equal(response.status, 201);
    sent.push(response.data.message);
  }
  for (const path of ['/inbox', `/threads/${thread.id}`]) {
    const seen = [];
    let cursor = '0', pages = 0;
    while (true) {
      const response = await call(`${path}?limit=100&after=${cursor}`, { key });
      assert.equal(response.status, 200);
      const page = response.data;
      assert.ok(page.items.length > 0, 'every nonempty page makes progress');
      assert.ok(Buffer.byteLength(JSON.stringify(page.items)) <= 256 * 1024, 'serialized UTF-8 item array respects byte budget');
      assert.equal(page.next_cursor, String(page.items.at(-1).seq));
      assert.ok(BigInt(page.next_cursor) > BigInt(cursor));
      assert.ok(page.items.every(m => m.content.payload === body.content.payload));
      seen.push(...page.items.map(m => m.id));
      assert.equal(page.has_more, seen.length < sent.length, 'byte-truncated tail sets has_more even below the item limit');
      cursor = page.next_cursor;
      pages++;
      if (!page.has_more) break;
      assert.ok(pages < sent.length, 'continuation must terminate without duplication');
    }
    assert.ok(pages > 1);
    assert.deepEqual(seen, sent.map(m => m.id));
  }
  // An oversized historical/imported row cannot trap the cursor forever. Current
  // API writes are bounded by 64 KiB, but previously stored data still must drain.
  const oversize = { url: 'https://example.com/legacy', payload: 'x'.repeat(300 * 1024) };
  await db.prepare('UPDATE messages SET content = ? WHERE id = ?').bind(JSON.stringify(oversize), sent[0].id).run();
  for (const path of ['/inbox', `/threads/${thread.id}`]) {
    const page = (await call(`${path}?limit=100`, { key })).data;
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].id, sent[0].id);
    assert.equal(page.next_cursor, String(sent[0].seq));
    assert.equal(page.has_more, true);
    const next = (await call(`${path}?limit=100&after=${page.next_cursor}`, { key })).data;
    assert.equal(next.items[0].id, sent[1].id);
  }
});

test('owner receiving status observes inbox checks, backlog and ACK without consuming deliveries', async () => {
  assert.equal((await call('/agents/receiving', { key: null })).status, 401);
  const created = (await call('/agents', { method: 'POST', body: { name: 'Receiving diagnostics' } })).data;
  const key = created.token.token, principal = created.principal.id;
  assert.equal((await call('/agents/receiving', { key })).status, 403);
  const find = async () => {
    const response = await call('/agents/receiving');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.data.check_resolution_seconds, 30);
    assert.ok(response.data.observed_at);
    return response.data.items.find(p => p.id === principal);
  };
  let status = await find();
  assert.equal(status.notification.state, 'unsupported');
  assert.equal(status.last_checked_at, null);
  assert.equal(status.receiving_mode, null);
  assert.equal(status.fallback_interval_seconds, null);
  const sent = (await call('/messages', { method: 'POST', idempotency: 'receiving-status-fixture', body: { to: [principal], type: 'text', content: 'Diagnostic test' } })).data.message;
  status = await find();
  assert.equal(status.pending_count, 1);
  assert.equal(status.oldest_pending.id, sent.id);
  assert.equal(status.oldest_pending.thread_id, sent.thread_id);
  assert.equal(status.oldest_pending.content, undefined, 'dashboard does not expose message bodies');
  assert.equal((await find()).pending_count, 1, 'observation must not ACK');
  assert.equal((await call('/inbox?include_acked=invalid', { key })).status, 400);
  assert.equal((await find()).last_checked_at, null, 'invalid checks are not recorded');
  await call('/probe', { key });
  const checked = (await find()).last_checked_at;
  assert.ok(checked);
  await call('/inbox', { key });
  assert.equal((await find()).last_checked_at, checked, 'writes are coalesced within 30 seconds');
  await db.prepare("UPDATE agent_receiving_activity SET last_checked_at='2000-01-01T00:00:00.000Z' WHERE principal_id=?").bind(principal).run();
  await call('/inbox', { key });
  assert.notEqual((await find()).last_checked_at, '2000-01-01T00:00:00.000Z');
  const reply = await call('/messages', { method: 'POST', key, idempotency: 'receiving-status-reply', body: { thread_id: sent.thread_id, content: 'Handled', type: 'text', reply_to: sent.id } });
  assert.equal(reply.status, 201);
  const ack = await call(`/messages/${sent.id}/ack`, { method: 'POST', key });
  status = await find();
  assert.equal(status.pending_count, 0);
  assert.equal(status.oldest_pending, null);
  assert.equal(status.last_ack_at, ack.data.acked_at);
  assert.equal(status.last_sent_at, reply.data.message.created_at);
  assert.doesNotMatch(JSON.stringify(status), /token|access_key|secret/);
  await call(`/principals/${principal}`, { method: 'PATCH', body: { active: false } });
  status = await find();
  assert.equal(status.notification.state, 'disabled');
  assert.equal(status.last_ack_at, ack.data.acked_at, 'disabling preserves historical processing evidence');
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

test('group title rename works for members only, and revoked invites cannot be redeemed', async () => {
  // Earlier pairing tests disabled these agents, revoking their original keys; mint fresh ones.
  const aKey = (await call('/tokens', { method: 'POST', body: { principal_id: a.id, label: 'Rename member' } })).data.token.token;
  const cKey = (await call('/tokens', { method: 'POST', body: { principal_id: c.id, label: 'Rename outsider' } })).data.token.token;
  const thread = (await call('/threads')).data.items.find(t => t.kind === 'group' && t.title === 'Overview isolation');
  assert.ok(thread, 'expected the Overview isolation group to exist');
  assert.equal((await call(`/threads/${thread.id}`, { method: 'PATCH', key: cKey, body: { title: 'Outsider rename' } })).status, 404); // non-member cannot rename
  assert.equal((await call(`/threads/${thread.id}`, { method: 'PATCH', key: aKey, body: { title: '' } })).status, 400);
  const renamed = await call(`/threads/${thread.id}`, { method: 'PATCH', key: aKey, body: { title: 'Overview isolation renamed' } });
  assert.equal(renamed.status, 200); assert.equal(renamed.data.thread.title, 'Overview isolation renamed');
  const direct = (await call('/threads')).data.items.find(t => t.kind === 'direct');
  assert.equal((await call(`/threads/${direct.id}`, { method: 'PATCH', body: { title: 'No direct rename' } })).status, 400);
  const invite = (await call('/invites', { method: 'POST', body: {} })).data.invite;
  assert.equal((await call(`/invites/${invite.id}`, { method: 'DELETE', key: aKey })).status, 403);
  assert.equal((await call(`/invites/${invite.id}`, { method: 'DELETE', body: {} })).status, 200);
  assert.equal((await call(`/invites/${invite.id.replace(/./g, '0')}`, { method: 'DELETE', body: {} })).status, 404);
  assert.equal((await call('/invites/redeem', { method: 'POST', key: null, body: { code: invite.code, name: 'Too late' } })).status, 410);
});

test('replies retain authenticated same-thread correlation across reads, replay and export', async () => {
  const key = (await call('/tokens', { method: 'POST', body: { principal_id: a.id, label: 'Reply member' } })).data.token.token;
  const thread = (await call('/threads', { method: 'POST', key, body: { title: 'Reply correlation', members: [ownerId] } })).data.thread;
  const send = (idempotency, body, caller = key) => call('/messages', { method: 'POST', key: caller, idempotency, body });
  const original = (await send('reply-original', { thread_id: thread.id, type: 'text', content: 'Which result?' })).data.message;
  assert.equal(Object.hasOwn(original, 'reply_to'), false);
  const body = { thread_id: thread.id, type: 'json', content: { result: 'Ready' }, reply_to: original.id };
  const sent = await send('reply-result', body);
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.reply_to, original.id);
  assert.equal((await db.prepare('SELECT reply_to FROM messages WHERE id = ?').bind(sent.data.message.id).first()).reply_to, original.id);
  const replay = await send('reply-result', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.message.id, sent.data.message.id);
  assert.equal(replay.data.message.reply_to, original.id);
  for (const path of [`/threads/${thread.id}`, `/inbox?after=${original.seq}`, `/export?after=${original.seq}`, '/overview']) {
    const result = await call(path);
    assert.equal(result.status, 200);
    assert.equal(result.data.items.find(m => m.id === sent.data.message.id)?.reply_to, original.id, path);
  }
  assert.equal((await call(`/messages/${sent.data.message.id}`, { key })).data.message.reply_to, original.id);
  const second = (await send('reply-original-2', { thread_id: thread.id, type: 'text', content: 'Another result?' })).data.message;
  assert.equal((await send('reply-result', { ...body, reply_to: second.id })).status, 409);
  assert.equal((await send('reply-result', { ...body, reply_to: null })).status, 409);
  // The original no-relation request hash must remain compatible across upgrades.
  const legacyReplay = await send('reply-original', { thread_id: thread.id, type: 'text', content: 'Which result?', reply_to: null });
  assert.equal(legacyReplay.status, 200);
  assert.equal(Object.hasOwn(legacyReplay.data.message, 'reply_to'), false);
  const oldReplay = await send('handoff-1', { thread_id: groupId, type: 'text', content: 'Build the release.' });
  assert.equal(oldReplay.status, 200);
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update(JSON.stringify({ destination: groupId, type: 'text', content: 'Build the release.' })).digest('hex');
  assert.equal((await db.prepare('SELECT request_hash FROM messages WHERE id = ?').bind(firstMessage.id).first()).request_hash, expected);
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => send('reply-concurrent', { ...body, content: 'One reply' })));
  assert.equal(concurrent.filter(r => r.status === 201).length, 1);
  assert.equal(new Set(concurrent.map(r => r.data.message.id)).size, 1);
  assert.ok(concurrent.every(r => r.data.message.reply_to === original.id));
});

test('reply targets reject missing, private and cross-thread IDs without revealing them', async () => {
  const key = (await call('/tokens', { method: 'POST', body: { principal_id: a.id, label: 'Reply validation' } })).data.token.token;
  const outsider = (await call('/tokens', { method: 'POST', body: { principal_id: c.id, label: 'Reply outsider' } })).data.token.token;
  const thread = (await call('/threads', { method: 'POST', key, body: { title: 'Reply target validation', members: [ownerId] } })).data.thread;
  const privateThread = (await call('/threads', { method: 'POST', key: outsider, body: { title: 'Private reply target', members: [ownerId] } })).data.thread;
  const privateMessage = (await call('/messages', { method: 'POST', key: outsider, idempotency: 'private-reply-target', body: { thread_id: privateThread.id, type: 'text', content: 'Private' } })).data.message;
  const base = { thread_id: thread.id, type: 'text', content: 'Reply' };
  for (const reply_to of ['msg_missing', privateMessage.id, firstMessage.id]) {
    const response = await call('/messages', { method: 'POST', key, idempotency: `invalid-reply-${reply_to}`, body: { ...base, reply_to } });
    assert.equal(response.status, 404);
    assert.equal(response.data.error.code, 'not_found');
    assert.equal(response.data.error.message, 'Message not found.');
  }
  const inaccessible = await call('/messages', { method: 'POST', key, idempotency: 'inaccessible-reply', body: { ...base, thread_id: privateThread.id, reply_to: privateMessage.id } });
  assert.equal(inaccessible.status, 404);
  for (const reply_to of ['', ' '.repeat(3), 12, {}, 'x'.repeat(81)]) {
    assert.equal((await call('/messages', { method: 'POST', key, idempotency: 'malformed-reply', body: { ...base, reply_to } })).status, 400);
  }
  assert.equal((await call('/messages', { method: 'POST', key, idempotency: 'reply-with-to', body: { to: [ownerId], type: 'text', content: 'Reply', reply_to: firstMessage.id } })).status, 400);
  assert.equal((await call(`/threads/${thread.id}`, { key })).data.items.length, 0);
});


test('reply migration preserves populated legacy history and nullable foreign-key integrity', async () => {
  let migrationDb;
  const sqlite = process.env.AGENTPEERCHAT_TEST_BACKEND === 'sqlite';
  if (sqlite) {
    const { SQLiteDatabase } = await import('../server/sqlite.mjs');
    migrationDb = new SQLiteDatabase(':memory:');
  } else migrationDb = await mf.getD1Database('MIGRATION_DB');
  try {
    const migrations = (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort();
    for (const file of migrations.filter(f => f < '0006_message_replies.sql')) {
      await migrationDb.exec((await readFile(`migrations/${file}`, 'utf8')).replaceAll('\n', ' '));
    }
    await migrationDb.exec("INSERT INTO principals(id,name,kind) VALUES ('migration-owner','Owner','owner'); INSERT INTO threads(id,title,created_by) VALUES ('migration-thread','Legacy','migration-owner'); INSERT INTO messages(id,thread_id,sender_id,type,content,idempotency_key,request_hash) VALUES ('migration-message','migration-thread','migration-owner','text','\"Legacy content\"','legacy-key','legacy-hash');");
    const before = await migrationDb.prepare("SELECT * FROM messages WHERE id = 'migration-message'").first();
    await migrationDb.exec((await readFile('migrations/0006_message_replies.sql', 'utf8')).replaceAll('\n', ' '));
    const after = await migrationDb.prepare("SELECT * FROM messages WHERE id = 'migration-message'").first();
    assert.deepEqual(after, { ...before, reply_to: null });
    const insert = target => migrationDb.prepare("INSERT INTO messages(id,thread_id,sender_id,type,content,idempotency_key,request_hash,reply_to) VALUES ('migration-reply','migration-thread','migration-owner','text','\"Reply\"','reply-key','reply-hash',?)").bind(target).run();
    await assert.rejects(insert('missing-message'));
    await insert('migration-message');
    await migrationDb.prepare("DELETE FROM messages WHERE id = 'migration-message'").run();
    assert.equal((await migrationDb.prepare("SELECT reply_to FROM messages WHERE id = 'migration-reply'").first()).reply_to, null);
  } finally { if (sqlite) migrationDb.close(); }
});
