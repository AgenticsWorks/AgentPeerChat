import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { SQLiteDatabase } from '../server/sqlite.mjs';

const built = await build({ entryPoints: ['src/wake-webhook.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const { WakeWebhook, webhookTarget, webhookAvailability } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const target = { provider: 'grokbot', url: 'https://hooks.example.test/routine', token: 'private-fixture-key' };
const config = value => ({ AGENTPEERCHAT_WAKE_WEBHOOKS: JSON.stringify({ recipient: value }) });
async function fixture(t, responder = async () => new Response(null, { status: 200 })) {
  const db = new SQLiteDatabase(':memory:'); t.after(() => db.close());
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile('migrations/' + file, 'utf8'));
  await db.exec("INSERT INTO principals(id,name,kind) VALUES ('sender','Sender','owner'),('recipient','Recipient','agent'); INSERT INTO threads(id,title,created_by) VALUES ('thread','Private','sender')");
  let now = Date.parse('2026-11-01T00:00:00Z'), seq = 0;
  const storage = { record: null, alarmAt: null,
    async get() { return structuredClone(this.record); }, async put(_, value) { this.record = structuredClone(value); },
    async setAlarm(value) { this.alarmAt = value; }, async deleteAlarm() { this.alarmAt = null; } };
  const env = { DB: db, NOTIFICATIONS: {}, ...config(target) }, requests = [];
  const fetcher = async (url, init) => { requests.push({ url, ...init, body: JSON.parse(init.body) }); return responder(url, init); };
  const create = () => new WakeWebhook(storage, env, fetcher, () => now);
  const wake = create();
  return { db, storage, env, requests, wake, create,
    async send() {
      seq++;
      await db.prepare("INSERT INTO messages(id,thread_id,sender_id,type,content,idempotency_key,request_hash) VALUES (?,'thread','sender','text','private message',?,?)").bind('m' + seq, 'key' + seq, 'hash' + seq).run();
      await db.prepare("INSERT INTO deliveries(recipient_id,message_seq) VALUES ('recipient',?)").bind(seq).run();
      return seq;
    },
    async tick(receiver = wake) { assert.notEqual(storage.alarmAt, null); now = storage.alarmAt; await receiver.alarm(); },
    async pending() { return (await db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE acked_at IS NULL').first()).n; }
  };
}

test('only operator-configured HTTPS Grok Bot targets are accepted; invalid config never reveals secrets', () => {
  assert.deepEqual(webhookTarget(config(target), 'recipient'), target);
  assert.equal(webhookTarget(config(target), 'other'), null);
  assert.equal(webhookTarget({}, 'recipient'), null);
  assert.equal(webhookAvailability(config(target), 'recipient').state, 'unsupported');
  for (const url of ['http://hooks.example.test', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://host.internal', 'https://user:password@hooks.example.test', 'https://hooks.example.test:8443', 'https://hooks.example.test/#secret']) {
    assert.throws(() => webhookTarget(config({ ...target, url }), 'recipient'), { message: 'Invalid wake webhook configuration.' });
  }
  for (const value of [{ ...target, provider: 'grok.com' }, { ...target, token: 'secret\r\nheader' }, null]) {
    assert.throws(() => webhookTarget(config(value), 'recipient'), { message: 'Invalid wake webhook configuration.' });
    assert.equal(webhookAvailability(config(value), 'recipient').state, 'invalid');
    assert.equal(webhookTarget(config(value), 'other'), null);
  }
});

test('durable coalescing survives restart, sends only a hint, and HTTP 200 never ACKs work', async t => {
  const f = await fixture(t);
  await f.send(); await f.wake.enqueue('recipient'); await f.send(); await f.wake.enqueue('recipient');
  assert.equal(f.requests.length, 0, 'enqueue must not wait for an external webhook');
  await f.tick(f.create());
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.headers.Authorization, 'Bearer ' + target.token);
  assert.equal(request.redirect, 'manual');
  assert.deepEqual(request.body, { type: 'agentpeerchat.mailbox_changed', principal_id: 'recipient', event_id: 'wake_recipient_2' });
  assert.equal(await f.pending(), 2);
  assert.equal((await f.wake.status('recipient')).state, 'accepted');
  assert.equal(await f.wake.enqueue('recipient'), false, 'replay does not wake an accepted batch again');
  assert.equal(f.storage.alarmAt, null);
  const stored = JSON.stringify(f.storage.record), publicView = JSON.stringify(await f.wake.status('recipient'));
  for (const privateValue of [target.url, target.token, 'private message']) { assert.ok(!stored.includes(privateValue)); assert.ok(!publicView.includes(privateValue)); }
  assert.ok(!publicView.includes('fingerprint'));
});

test('transient failures retain pending work and backoff across restart, then stop after five attempts', async t => {
  const f = await fixture(t, async () => { throw Error(target.token); });
  await f.send(); await f.wake.enqueue('recipient');
  for (let i = 1; i <= 5; i++) {
    await f.tick(f.create());
    assert.equal(f.requests.length, i);
    assert.equal((await f.wake.status('recipient')).state, i === 5 ? 'failed' : 'retrying');
    if (i < 5) {
      assert.equal(f.storage.alarmAt - Date.parse(f.storage.record.last_attempt_at), 30000 * 2 ** (i - 1));
      const alarm = f.storage.alarmAt;
      await f.wake.enqueue('recipient', true);
      assert.equal(f.storage.alarmAt, alarm, 'manual retries cannot bypass an active backoff');
    }
  }
  assert.equal(await f.pending(), 1); assert.equal(f.storage.alarmAt, null);
  assert.equal(await f.wake.enqueue('recipient'), false);
  assert.equal(await f.wake.enqueue('recipient', true), true);
  assert.equal((await f.wake.status('recipient')).attempts, 0);
});

test('rate limits honor Retry-After and a newer message cannot reset the backoff', async t => {
  const f = await fixture(t, async () => new Response('private response', { status: 429, headers: { 'Retry-After': '180' } }));
  await f.send(); await f.wake.enqueue('recipient'); await f.tick();
  assert.equal(f.storage.alarmAt - Date.parse(f.storage.record.last_attempt_at), 180000);
  const next = f.storage.alarmAt;
  await f.send(); await f.wake.enqueue('recipient');
  assert.equal(f.storage.alarmAt, next); assert.equal(f.storage.record.attempts, 1);
});

test('non-200 successes, redirects and permanent errors fail closed without following or accepting them', async t => {
  for (const status of [202, 301, 401, 403, 404]) {
    const f = await fixture(t, async () => new Response(null, { status, headers: { Location: 'https://other.example.test' } }));
    await f.send(); await f.wake.enqueue('recipient'); await f.tick();
    assert.equal((await f.wake.status('recipient')).state, 'failed');
    assert.equal((await f.wake.status('recipient')).last_http_status, status);
    assert.equal(f.requests.length, 1); assert.equal(await f.pending(), 1);
  }
});

test('an interrupted outbound attempt is recovered from durable state', async t => {
  const f = await fixture(t);
  await f.send(); await f.wake.enqueue('recipient');
  f.storage.record.state = 'sending'; f.storage.record.attempts = 1; f.storage.record.attempt_id = 'interrupted';
  await f.tick(f.create());
  assert.equal(f.requests.length, 1); assert.equal((await f.wake.status('recipient')).attempts, 2);
});

test('ACK, disable or removed configuration cancels a queued wake before sending', async t => {
  for (const action of ['ack', 'disable', 'remove', 'invalid']) {
    const f = await fixture(t); await f.send(); await f.wake.enqueue('recipient');
    if (action === 'ack') await f.db.exec("UPDATE deliveries SET acked_at='2026-11-01T00:00:00Z'");
    if (action === 'disable') await f.db.exec("UPDATE principals SET active=0 WHERE id='recipient'");
    if (action === 'remove') delete f.env.AGENTPEERCHAT_WAKE_WEBHOOKS;
    if (action === 'invalid') f.env.AGENTPEERCHAT_WAKE_WEBHOOKS = '{invalid';
    await f.tick(f.create());
    assert.equal(f.requests.length, 0); assert.equal(f.storage.alarmAt, null);
  }
});

test('rotation uses the new secret and allows a pending accepted batch to be retried', async t => {
  const f = await fixture(t); await f.send(); await f.wake.enqueue('recipient'); await f.tick();
  f.env.AGENTPEERCHAT_WAKE_WEBHOOKS = config({ ...target, token: 'rotated-fixture-key' }).AGENTPEERCHAT_WAKE_WEBHOOKS;
  assert.equal((await f.wake.status('recipient')).state, 'ready');
  await f.wake.enqueue('recipient'); await f.tick();
  assert.equal(f.requests[1].headers.Authorization, 'Bearer rotated-fixture-key');
  assert.equal(await f.pending(), 1);
});

test('messages arriving during the outbound request produce a trailing wake, without losing the in-flight result', async t => {
  let release;
  const f = await fixture(t, () => new Promise(resolve => { release = () => resolve(new Response()); }));
  await f.send(); await f.wake.enqueue('recipient');
  const first = f.tick();
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  await f.send(); await f.wake.enqueue('recipient'); release(); await first;
  assert.equal((await f.wake.status('recipient')).state, 'queued');
  release = null;
  const second = f.tick();
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  release(); await second;
  assert.deepEqual(f.requests.map(r => r.body.event_id), ['wake_recipient_1', 'wake_recipient_2']);
  assert.equal((await f.wake.status('recipient')).state, 'accepted');
  assert.equal(await f.pending(), 2);
});
