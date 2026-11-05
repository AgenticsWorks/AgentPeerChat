import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf, db, owner, agent, human, other, cookie;
const origin = 'https://wake-setup.test';
const target = { provider: 'grokbot', url: 'https://api2.cursor.sh/automations/webhook/fixture-private', token: 'private-sender-fixture-key' };
const requests = [];
async function call(path, { key = owner, method = 'GET', body, idem = crypto.randomUUID(), extra = {} } = {}) {
  const response = await mf.dispatchFetch(origin + '/api/v1' + path, { method,
    headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), 'Content-Type': 'application/json',
      ...(idem ? { 'Idempotency-Key': idem } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
const path = () => '/agents/' + agent.id + '/wake';
async function until(check) {
  const end = Date.now() + 12000;
  while (!await check()) { if (Date.now() > end) throw Error('Condition timed out'); await new Promise(resolve => setTimeout(resolve, 40)); }
}
before(async () => {
  const bundled = await build({ entryPoints: ['src/cloudflare.ts'], bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'wake-config-test', modules: true,
    script: bundled.outputFiles[0].text, compatibilityDate: '2026-10-02', d1Databases: { DB: 'wake-config-db' },
    durableObjects: { NOTIFICATIONS: { className: 'MailboxHub', useSQLite: true } }, bindings: { SETUP_SECRET: 'private-setup-fixture-key' },
    serviceBindings: { ASSETS: async () => new Response('assets') },
    outboundService: async request => { requests.push({ url: request.url, header: request.headers.get('Authorization'), body: await request.json() }); return new Response(null, { status: 200 }); }
  }] }));
  db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec((await readFile('migrations/' + file, 'utf8')).replaceAll('\n', ' '));
  owner = (await call('/setup', { key: null, method: 'POST', body: { name: 'Owner', setup_secret: 'private-setup-fixture-key' } })).data.access_key;
  async function newAgent(name) {
    const principal = (await call('/agents', { method: 'POST', body: { name } })).data.principal;
    return { id: principal.id, key: (await call('/tokens', { method: 'POST', body: { principal_id: principal.id, label: 'fixture' } })).data.token.token };
  }
  agent = await newAgent('Hosted Agent'); other = await newAgent('Other Agent');
  const invite = (await call('/invites', { method: 'POST', body: {} })).data.invite;
  human = (await call('/invites/redeem', { key: null, method: 'POST', body: { code: invite.code, name: 'Teammate' } })).data.access_key;
  const session = await call('/session', { method: 'POST', body: { access_key: owner }, extra: { Origin: origin } });
  cookie = session.headers.get('Set-Cookie').split(';')[0];
});
after(async () => { await mf?.dispose(); });

test('private setup is owner-only, same-origin cookie protected, and own-agent status has no owner capability', async () => {
  for (const key of [null, agent.key, other.key, human]) {
    for (const method of ['GET', 'PUT', 'DELETE']) assert.equal((await call(path() + '/config', { key, method, body: method === 'PUT' ? target : undefined })).status, key ? 403 : 401);
  }
  for (const method of ['PUT', 'DELETE']) {
    const result = await call(path() + '/config', { key: null, method, body: method === 'PUT' ? target : undefined, extra: { Cookie: cookie, Origin: 'https://attacker.test' } });
    assert.equal(result.status, 403);
  }
  const own = await call('/receiver/wake', { key: agent.key });
  assert.equal(own.status, 200); assert.equal(own.data.configured, false);
  assert.equal(own.data.setup_url, origin + '/#wake-agent=' + agent.id);
  assert.equal((await call('/receiver/wake', { key: owner })).status, 403);
  assert.equal((await call('/receiver/wake', { key: agent.key, method: 'PUT', body: target })).status, 405);
  assert.equal((await call(path() + '/test', { idem: null, method: 'POST' })).status, 400);
  assert.equal((await call(path() + '/test', { method: 'POST' })).status, 409);
});

test('saving stores private configuration without waking; read surfaces and rejected input never leak credentials', async () => {
  const invalid = await call(path() + '/config', { method: 'PUT', body: { ...target, url: 'https://attacker.test/private-secret-path' } });
  assert.equal(invalid.status, 400); assert.ok(!JSON.stringify(invalid.data).includes('private-secret-path'));
  const saved = await call(path() + '/config', { key: null, method: 'PUT', body: target, extra: { Cookie: cookie, Origin: origin } });
  assert.equal(saved.status, 200); assert.equal(saved.data.configured, true); assert.equal(saved.data.source, 'private');
  assert.equal(saved.data.wake_webhook.state, 'ready'); assert.equal(saved.data.verification, null); assert.equal(requests.length, 0);
  for (const status of [saved, await call(path() + '/config'), await call('/receiver/wake', { key: agent.key }), await call('/agents/receiving'), await call('/agents/presence')]) {
    assert.equal(status.headers.get('Cache-Control'), 'no-store');
    for (const secret of [target.url, target.token, 'fingerprint', 'wake-webhook-private-config']) assert.ok(!JSON.stringify(status.data).includes(secret));
  }
  assert.equal((await call('/receiver/wake', { key: other.key })).data.configured, false);
});

test('native acceptance stays unverified until the exact Agent replies and ACKs; retries reuse the test', async () => {
  const idem = crypto.randomUUID(), first = await call(path() + '/test', { method: 'POST', idem });
  assert.equal(first.status, 202); assert.equal(first.data.verification.state, 'waiting');
  const message = first.data.verification;
  const retries = await Promise.all([call(path() + '/test', { method: 'POST', idem }), call(path() + '/test', { method: 'POST' })]);
  for (const result of retries) assert.equal(result.data.verification.message_id, message.message_id);
  await until(async () => (await call(path() + '/config')).data.wake_webhook.state === 'accepted');
  assert.equal(requests.length, 1); assert.equal(requests[0].url, target.url); assert.equal(requests[0].header, 'Bearer ' + target.token);
  assert.deepEqual(Object.keys(requests[0].body).sort(), ['event_id', 'principal_id', 'type']);
  assert.equal((await call(path() + '/config')).data.verification.state, 'waiting');
  const inbox = (await call('/inbox', { key: agent.key })).data.items;
  assert.equal(inbox.filter(m => m.id === message.message_id).length, 1);
  const reply = await call('/messages', { key: agent.key, method: 'POST', body: { thread_id: message.thread_id, type: 'text', content: '714', reply_to: message.message_id } });
  assert.equal(reply.status, 201);
  assert.equal((await call(path() + '/config')).data.verification.state, 'replied');
  assert.equal((await call('/messages/' + message.message_id + '/ack', { key: agent.key, method: 'POST', body: {} })).status, 200);
  assert.equal((await call(path() + '/config')).data.verification.state, 'verified');
  const rotated = await call(path() + '/config', { method: 'PUT', body: { ...target, token: 'rotated-private-fixture' } });
  assert.equal(rotated.data.verification, null); assert.equal(rotated.data.wake_webhook.state, 'ready');
});

test('disconnect cancels queued wakes, removes private credentials and supports reconnect without new identity', async () => {
  const test = await call(path() + '/test', { method: 'POST' });
  assert.equal(test.status, 202);
  const removed = await call(path() + '/config', { method: 'DELETE' });
  assert.equal(removed.status, 200); assert.equal(removed.data.configured, false); assert.equal(removed.data.verification, null);
  assert.equal((await call(path(), { method: 'POST' })).status, 409);
  await new Promise(resolve => setTimeout(resolve, 1200)); assert.equal(requests.length, 1);
  assert.ok((await call('/inbox', { key: agent.key })).data.items.some(m => m.id === test.data.verification.message_id), 'disconnect never discards pending mail');
  await db.prepare('UPDATE principals SET active=0 WHERE id=?').bind(agent.id).run();
  assert.equal((await call(path() + '/config', { method: 'PUT', body: target })).status, 400);
  assert.equal((await call(path() + '/config', { method: 'DELETE' })).status, 200);
  await db.prepare('UPDATE principals SET active=1 WHERE id=?').bind(agent.id).run();
  assert.equal((await call(path() + '/config', { method: 'PUT', body: target })).data.configured, true);
  assert.equal((await call('/me', { key: agent.key })).data.principal.id, agent.id);
});
