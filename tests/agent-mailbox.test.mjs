import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let runtime, db, owner, a, b, human, thread, first;
const origin = 'https://mailbox.test', setup = 'disposable-mailbox-test-secret-only';
async function call(path, key = owner, method = 'GET', body) {
  const response = await runtime.dispatchFetch(origin + '/api/v1' + path, { method,
    headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
before(async () => {
  const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
  if (process.env.AGENTPEERCHAT_TEST_BACKEND === 'sqlite') {
    const { SQLiteDatabase } = await import('../server/sqlite.mjs');
    const worker = (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
    db = new SQLiteDatabase(':memory:');
    runtime = { dispatchFetch: (url, init) => worker.fetch(new Request(url, init), { DB: db, SETUP_SECRET: setup }), dispose: () => db.close() };
  } else {
    runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'mailbox', modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: '2026-10-02', d1Databases: { DB: 'mailbox' }, bindings: { SETUP_SECRET: setup } }] }));
    db = await runtime.getD1Database('DB');
  }
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec((await readFile('migrations/' + file, 'utf8')).replaceAll('\n', ' '));
  owner = (await call('/setup', null, 'POST', { name: 'Owner', setup_secret: setup })).data.access_key;
  a = (await call('/agents', owner, 'POST', { name: 'Reader' })).data;
  b = (await call('/agents', owner, 'POST', { name: 'Other Agent' })).data;
  const invite = (await call('/invites', owner, 'POST', {})).data.invite;
  human = (await call('/invites/redeem', null, 'POST', { code: invite.code, name: 'Observer' })).data.access_key;
  first = (await call('/messages', owner, 'POST', { to: [a.principal.id], type: 'text', content: '<img src=x onerror=alert(1)> 100%_literal' })).data.message;
  thread = first.thread_id;
  await call('/messages', owner, 'POST', { to: [b.principal.id], type: 'text', content: 'Private to other Agent' });
});
after(async () => { await runtime?.dispose(); });
const mailbox = (query = '', id = a.principal.id, key = owner) => call(`/agents/${id}/mailbox${query}`, key);

test('only the owner can inspect an Agent mailbox, including disabled Agents', async () => {
  assert.equal((await mailbox('', a.principal.id, null)).status, 401);
  for (const key of [a.token.token, b.token.token, human]) assert.equal((await mailbox('', a.principal.id, key)).status, 403);
  assert.equal((await mailbox('', 'missing')).status, 404);
  const ownerId = (await call('/me')).data.principal.id;
  assert.equal((await mailbox('', ownerId)).status, 404);
  await call('/principals/' + b.principal.id, owner, 'PATCH', { active: false });
  assert.equal((await mailbox('', b.principal.id)).data.items[0].content, 'Private to other Agent');
});

test('observation returns body and context without ACK, receiver metadata or a false Agent inbox check', async () => {
  const before = (await db.prepare('SELECT * FROM deliveries ORDER BY message_seq, recipient_id').all()).results;
  const result = await mailbox(); assert.equal(result.status, 200);
  assert.equal(result.data.items[0].content, first.content);
  assert.equal(result.data.items[0].sender_name, 'Owner');
  assert.equal(result.data.items[0].thread_id, thread);
  assert.equal(result.data.items[0].acked_at, null);
  assert.equal('request_hash' in result.data.items[0], false);
  assert.equal('idempotency_key' in result.data.items[0], false);
  assert.deepEqual(result.data.totals, { total: 1, pending: 1, acked: 0 });
  assert.deepEqual((await db.prepare('SELECT * FROM deliveries ORDER BY message_seq, recipient_id').all()).results, before);
  assert.equal(await db.prepare('SELECT * FROM agent_receiving_activity WHERE principal_id = ?').bind(a.principal.id).first(), null);
});

test('pending, acknowledged and all filters track the recipient ACK and literal search', async () => {
  await call('/messages/' + first.id + '/ack', a.token.token, 'POST');
  const second = (await call('/messages', owner, 'POST', { thread_id: thread, type: 'json', content: { result: 'Unicode 中文', value: 42 } })).data.message;
  assert.deepEqual((await mailbox()).data.items.map(m => m.id), [second.id]);
  assert.deepEqual((await mailbox('?status=acked')).data.items.map(m => m.id), [first.id]);
  const all = (await mailbox('?status=all')).data;
  assert.deepEqual(all.items.map(m => m.id), [second.id, first.id]);
  assert.deepEqual(all.totals, { total: 2, pending: 1, acked: 1 });
  assert.deepEqual(all.items[0].content, second.content);
  assert.deepEqual((await mailbox('?status=all&q=' + encodeURIComponent('%_literal'))).data.items.map(m => m.id), [first.id]);
  assert.equal((await mailbox('?q=not-present')).data.items.length, 0);
  assert.equal((await mailbox('?q=Owner')).data.items.length, 1);
});

test('newest-first keyset pages remain stable across new messages and reject invalid input', async () => {
  const one = (await mailbox('?status=all&limit=1')).data;
  assert.equal(one.has_more, true);
  await call('/messages', owner, 'POST', { thread_id: thread, type: 'text', content: 'Arrived during pagination' });
  const next = (await mailbox('?status=all&limit=1&before=' + one.next_cursor)).data;
  assert.equal(next.items[0].id, first.id); assert.equal(next.has_more, false);
  for (const query of ['?status=unknown', '?before=-1', '?before=9007199254740992', '?limit=101', '?limit=0', '?q=' + 'x'.repeat(201)]) assert.equal((await mailbox(query)).status, 400, query);
});

test('byte-bounded pagination returns every large delivery exactly once', async () => {
  const fixture = [];
  for (let i = 0; i < 18; i++) {
    const message = (await call('/messages', owner, 'POST', { thread_id: thread, type: 'text', content: String(i) + '界'.repeat(5000) })).data.message;
    fixture.push(message.id);
  }
  const seen = [], pages = []; let cursor;
  do {
    const result = (await mailbox('?status=all&limit=100' + (cursor ? '&before=' + cursor : ''))).data;
    pages.push(result); seen.push(...result.items.map(m => m.id));
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);
  assert.ok(pages.length >= 2, 'large bodies must split at the page byte budget');
  assert.equal(new Set(seen).size, seen.length);
  for (const id of fixture) assert.ok(seen.includes(id));
});
