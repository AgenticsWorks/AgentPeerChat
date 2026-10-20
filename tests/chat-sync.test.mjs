import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatSync } from '../public/chat-sync.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(refresh = async () => {}, random = () => 0) {
  let clock = 1000, nextId = 0;
  const timers = new Map(), states = [];
  const env = { visible: true, online: true, calls: 0, unauthorized: 0 };
  const sync = createChatSync({
    refresh: isCurrent => { env.calls++; return refresh(isCurrent); },
    onState: state => states.push(state),
    onUnauthorized: () => { env.unauthorized++; },
    isVisible: () => env.visible, isOnline: () => env.online,
    now: () => clock, random,
    setTimer: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id)
  });
  return {
    sync, env, states, timers,
    delay: () => [...timers.values()][0]?.delay,
    async tick() {
      assert.equal(timers.size, 1, 'only one poll should be scheduled');
      const [id, timer] = [...timers][0]; timers.delete(id);
      clock += timer.delay; timer.callback(); await settle();
    }
  };
}

test('polls after completion, records the successful time, and preserves jitter', async () => {
  const f = fixture(undefined, () => 0.5);
  await f.sync.start();
  assert.equal(f.env.calls, 1);
  assert.deepEqual(f.sync.snapshot(), { status: 'synced', lastSyncedAt: 1000 });
  assert.equal(f.delay(), 32500);
  await f.tick();
  assert.equal(f.env.calls, 2);
  assert.equal(f.sync.snapshot().lastSyncedAt, 33500);
});

test('hidden tabs pause polling and returning to the tab refreshes immediately', async () => {
  const f = fixture();
  await f.sync.start();
  f.env.visible = false; f.sync.availabilityChanged();
  assert.equal(f.sync.snapshot().status, 'paused');
  assert.equal(f.timers.size, 0);
  await f.sync.refresh();
  assert.equal(f.env.calls, 1);
  f.env.visible = true; f.sync.availabilityChanged();
  assert.equal(f.sync.snapshot().status, 'syncing');
  await settle();
  assert.equal(f.env.calls, 2, 'resume must not wait for a timer');
  assert.equal(f.delay(), 30000);
});

test('offline startup waits for connectivity and does not poll until also visible', async () => {
  const f = fixture();
  f.env.online = false;
  await f.sync.start();
  assert.deepEqual(f.sync.snapshot(), { status: 'offline', lastSyncedAt: null });
  assert.equal(f.env.calls, 0);
  f.env.visible = false; f.env.online = true; f.sync.availabilityChanged();
  await settle();
  assert.equal(f.env.calls, 0);
  assert.equal(f.timers.size, 0);
  f.env.visible = true; f.sync.availabilityChanged();
  await settle();
  assert.equal(f.env.calls, 1);
});

test('failures back off to five minutes without advancing the successful sync time', async () => {
  let failing = false;
  const f = fixture(async () => { if (failing) throw new Error('Unavailable'); });
  await f.sync.start();
  failing = true;
  for (const expected of [60000, 120000, 240000, 300000, 300000]) {
    await f.tick();
    assert.equal(f.delay(), expected);
    assert.deepEqual(f.sync.snapshot(), { status: 'retrying', lastSyncedAt: 1000 });
  }
  f.env.online = false; f.sync.availabilityChanged();
  assert.equal(f.sync.snapshot().status, 'offline');
  assert.equal(f.timers.size, 0);
  failing = false; f.env.online = true; f.sync.availabilityChanged();
  await settle();
  assert.equal(f.env.calls, 7, 'reconnect bypasses backoff');
  assert.equal(f.sync.snapshot().status, 'synced');
  assert.equal(f.delay(), 30000);
});

test('overlapping refreshes coalesce into one trailing request and callers await it', async () => {
  const first = deferred(), trailing = deferred();
  let calls = 0, concurrent = 0, maximum = 0;
  const f = fixture(async () => {
    maximum = Math.max(maximum, ++concurrent);
    await (++calls === 1 ? first : trailing).promise;
    concurrent--;
  });
  let completed = false;
  const initial = f.sync.start().then(() => { completed = true; });
  await settle();
  const mutation = f.sync.refresh();
  f.env.visible = false; f.sync.availabilityChanged();
  f.env.visible = true; f.sync.availabilityChanged();
  assert.equal(f.env.calls, 1);
  assert.equal(f.timers.size, 0);
  first.resolve(); await settle();
  assert.equal(f.env.calls, 2);
  assert.equal(completed, false, 'callers wait for the fresh snapshot after their mutation');
  trailing.resolve(); await Promise.all([initial, mutation]);
  assert.equal(maximum, 1);
  assert.equal(f.env.calls, 2);
  assert.equal(f.timers.size, 1);
});

test('a tab hidden during a request stays paused when that request completes', async () => {
  const pending = deferred(), f = fixture(() => pending.promise);
  const initial = f.sync.start(); await settle();
  f.env.visible = false; f.sync.availabilityChanged();
  pending.resolve(); await initial;
  assert.deepEqual(f.sync.snapshot(), { status: 'paused', lastSyncedAt: 1000 });
  assert.equal(f.timers.size, 0);
});

test('expired sessions stop receiving and require sign-in exactly once', async () => {
  const f = fixture(async () => { throw Object.assign(new Error('Expired'), { status: 401 }); });
  await assert.rejects(f.sync.start(), /Expired/);
  assert.equal(f.env.unauthorized, 1);
  assert.deepEqual(f.sync.snapshot(), { status: 'idle', lastSyncedAt: null });
  f.sync.availabilityChanged(); await f.sync.refresh();
  assert.equal(f.timers.size, 0);
  assert.equal(f.env.calls, 1);
});

test('stopping invalidates in-flight work and stale failures cannot sign out a new session', async () => {
  const pending = deferred();
  let oldIsCurrent;
  const f = fixture(isCurrent => {
    if (!oldIsCurrent) { oldIsCurrent = isCurrent; return pending.promise; }
  });
  const old = f.sync.start(); await settle();
  f.sync.stop();
  assert.equal(oldIsCurrent(), false);
  await f.sync.start();
  pending.reject(Object.assign(new Error('Old session expired'), { status: 401 }));
  await old;
  assert.equal(f.env.unauthorized, 0);
  assert.equal(f.sync.snapshot().status, 'synced');
  assert.equal(f.timers.size, 1);
  f.sync.stop();
  assert.equal(f.timers.size, 0);
});

test('stopping before a scheduled refresh starts does not send a request', async () => {
  const f = fixture();
  const initial = f.sync.start();
  f.sync.stop(); await initial;
  assert.equal(f.env.calls, 0);
});
