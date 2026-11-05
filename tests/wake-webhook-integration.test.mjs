import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let mf, base, db, owner, agentKey, other, release;
const requests = [], agent = 'agt_webhook_fixture';
const routineKey = 'private-routine-fixture-key';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 12000;
  while (!await check()) { if (Date.now() > end) throw Error('Condition timed out'); await pause(30); }
}
async function call(path, { key = owner, method = 'GET', body, idem = crypto.randomUUID() } = {}) {
  const response = await fetch(base + '/api/v1' + path, { method,
    headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': idem },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
}
before(async () => {
  const bundled = await build({ entryPoints: ['src/cloudflare.ts'], bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
  mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'wake-test', modules: true,
    script: bundled.outputFiles[0].text, compatibilityDate: '2026-10-02', d1Databases: { DB: 'wake-db' },
    durableObjects: { NOTIFICATIONS: { className: 'MailboxHub', useSQLite: true } },
    bindings: { SETUP_SECRET: 'private-local-wake-test-secret', AGENTPEERCHAT_WAKE_WEBHOOKS: JSON.stringify({
      [agent]: { provider: 'grokbot', url: 'https://hooks.example.test/routine', token: routineKey }
    }) },
    serviceBindings: { ASSETS: async () => new Response('assets') },
    outboundService: async request => {
      assert.equal(request.url, 'https://hooks.example.test/routine');
      assert.equal(request.headers.get('Authorization'), 'Bearer ' + routineKey);
      requests.push(await request.json());
      await new Promise(resolve => { release = resolve; });
      return new Response(null, { status: 200 });
    }
  }] }));
  db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec((await readFile('migrations/' + file, 'utf8')).replaceAll('\n', ' '));
  base = (await mf.ready).origin;
  owner = (await call('/setup', { key: null, method: 'POST', body: { name: 'Owner', setup_secret: 'private-local-wake-test-secret' } })).data.access_key;
  await db.prepare("INSERT INTO principals(id,name,kind) VALUES (?,'Grok Bot','agent')").bind(agent).run();
  agentKey = (await call('/tokens', { method: 'POST', body: { principal_id: agent, label: 'Test device' } })).data.token.token;
  other = (await call('/agents', { method: 'POST', body: { name: 'Unconfigured Agent' } })).data.principal.id;
});
after(async () => { release?.(); await mf?.dispose(); });

test('committed API messages trigger a real Durable Object alarm; accepted wake retains mailbox and never claims a live connection', async () => {
  const body = { to: [agent], type: 'text', content: 'Private task: calculate 37 * 19 + 11.' }, idem = crypto.randomUUID();
  const sent = await call('/messages', { method: 'POST', body, idem });
  assert.equal(sent.status, 201, 'message response must not wait for webhook response');
  await until(() => release);
  assert.equal(requests.length, 1); assert.deepEqual(Object.keys(requests[0]).sort(), ['event_id', 'principal_id', 'type']);
  const processing = (await call('/agents/receiving')).data.items.find(a => a.id === agent);
  assert.equal(processing.wake_webhook.state, 'sending'); assert.equal(processing.pending_count, 1);
  release();
  await until(async () => (await call('/agents/receiving')).data.items.find(a => a.id === agent).wake_webhook.state === 'accepted');
  const report = (await call('/agents/receiving')).data;
  const status = report.items.find(a => a.id === agent);
  assert.equal(status.notification.state, 'disconnected'); assert.equal(status.pending_count, 1);
  assert.equal(report.items.find(a => a.id === other).wake_webhook, null);
  for (const secret of [routineKey, 'hooks.example.test', agentKey]) assert.ok(!JSON.stringify(report).includes(secret));
  assert.equal((await call('/messages', { method: 'POST', body, idem })).status, 200);
  await pause(1200); assert.equal(requests.length, 1, 'idempotent replay must not re-trigger an accepted batch');
  const inbox = (await call('/inbox', { key: agentKey })).data.items;
  assert.ok(inbox.some(m => m.id === sent.data.message.id));
  assert.equal((await call('/messages/' + sent.data.message.id + '/ack', { key: agentKey, method: 'POST', body: {} })).status, 200);
  assert.equal((await call('/agents/' + agent + '/wake', { method: 'POST' })).data.queued, false);
});

test('only the owner can retry a configured, enabled Agent; enqueue never ACKs or duplicates an already queued attempt', async () => {
  const path = '/agents/' + agent + '/wake';
  assert.equal((await call(path, { key: null, method: 'POST' })).status, 401);
  assert.equal((await call(path, { key: agentKey, method: 'POST' })).status, 403);
  const invite = (await call('/invites', { method: 'POST', body: {} })).data.invite;
  const human = (await call('/invites/redeem', { key: null, method: 'POST', body: { code: invite.code, name: 'Teammate' } })).data.access_key;
  assert.equal((await call(path, { key: human, method: 'POST' })).status, 403);
  assert.equal((await call('/agents/' + other + '/wake', { method: 'POST' })).status, 409);
  // Reproduce pending mail after a missed enqueue, without making a model request.
  await db.prepare('UPDATE deliveries SET acked_at=NULL WHERE recipient_id=?').bind(agent).run();
  for (let i = 0; i < 2; i++) {
    const result = await call(path, { method: 'POST' });
    assert.equal(result.status, 202); assert.equal(result.data.queued, true);
  }
  assert.equal((await call('/agents/receiving')).data.items.find(a => a.id === agent).pending_count, 1);
  await db.prepare('UPDATE principals SET active=0 WHERE id=?').bind(agent).run();
  assert.equal((await call(path, { method: 'POST' })).status, 400);
  await pause(1300); assert.equal(requests.length, 1, 'disabled Agent must not be woken by its queued alarm');
});
