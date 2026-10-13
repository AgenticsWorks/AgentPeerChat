import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestJSON} from '../scripts/client-transport.mjs';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {status, headers});
const url = 'https://example.invalid/api/v1/messages';
function harness(replies) {
  let clock = 0; const requests = [], delays = [];
  return {requests, delays, options: {random: () => 0, now: () => clock,
    wait: async delay => {delays.push(delay); clock += delay;},
    fetchImpl: async (url, options) => {requests.push({url, ...options}); const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply;}}};
}

test('uncertain sends retry identical serialized content and one generated key', async () => {
  const h = harness([new Error('private-provider-details'), new Response('<html>unavailable</html>', {status: 502}), json({message: {id: 'msg_1'}})]);
  assert.deepEqual(await requestJSON(url, {method: 'POST', token: 'fixture', send: true, body: {content: {a: 1}}}, h.options), {message: {id: 'msg_1'}});
  assert.equal(h.requests.length, 3); assert.deepEqual(h.delays, [250, 500]);
  assert.equal(new Set(h.requests.map(r => r.headers['Idempotency-Key'])).size, 1);
  assert.equal(new Set(h.requests.map(r => r.body)).size, 1);
  assert.ok(h.requests.every(r => r.redirect === 'error'));
});
test('supplied occurrence key is retained and Retry-After is honored', async () => {
  const h = harness([json({}, 429, {'Retry-After': '2'}), json({ok: true})]);
  await requestJSON(url, {method: 'POST', send: true, idempotencyKey: 'scheduled-fixture', body: {content: 'hello'}}, h.options);
  assert.deepEqual(h.delays, [2000]); assert.ok(h.requests.every(r => r.headers['Idempotency-Key'] === 'scheduled-fixture'));
});
test('reads and acknowledgments retry, but unrelated mutations never do', async () => {
  for (const [method, path, count] of [['GET', '/inbox', 2], ['POST', '/messages/msg_1/ack', 2], ['POST', '/threads', 1], ['PATCH', '/me', 1]]) {
    const h = harness([json({}, 503), json({ok: true})]);
    const result = requestJSON('https://example.invalid/api/v1' + path, {method}, h.options);
    if (count === 1) await assert.rejects(result, /^Error: 503:/); else await result;
    assert.equal(h.requests.length, count);
  }
});
test('permanent errors and long server cooldowns are not retried', async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const h = harness([json({error: {message: 'Rejected'}}, status)]);
    await assert.rejects(requestJSON(url, {method: 'POST', send: true}, h.options), new RegExp(`${status}: Rejected`));
    assert.equal(h.requests.length, 1);
  }
  const h = harness([new Response('provider private details', {status: 503, headers: {'Retry-After': '60'}})]);
  await assert.rejects(requestJSON(url, {}, h.options), /503: Request failed/); assert.deepEqual(h.delays, []);
});
test('HTTP-date Retry-After, invalid dates and malformed successful JSON are bounded', async () => {
  const dated = harness([json({}, 503, {'Retry-After': new Date(3000).toUTCString()}), json({ok: true})]);
  await requestJSON(url, {}, dated.options); assert.deepEqual(dated.delays, [3000]);
  const malformed = harness([new Response('not json'), json({}, 503, {'Retry-After': 'invalid'}), json({ok: true})]);
  await requestJSON(url, {}, malformed.options); assert.deepEqual(malformed.delays, [250, 500]);
  const failed = harness([new Error('secret'), new Error('secret'), new Error('secret')]);
  await assert.rejects(requestJSON(url, {}, failed.options), /^Error: Request failed before a valid response was received\.$/);
  assert.equal(failed.requests.length, 3);
});

test('serialized envelopes are bounded before networking, including escaped text', async () => {
  const h = harness([]);
  await assert.rejects(requestJSON(url, {method: 'POST', send: true, body: {content: '\0'.repeat(16384)}}, h.options), /64 KiB/);
  assert.equal(h.requests.length, 0);
});
