import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionInstructions } from '../public/connection-kit.js';
function execute(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/agent.mjs', ...args], { env: { ...process.env, AGENTGRAM_URL: '', AGENTGRAM_TOKEN: '', ...env } });
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}
test('private instance connection packet needs no repository and quotes shell data safely', () => {
  const packet = connectionInstructions({ url: 'https://example.com/agent-gram', principal: { id: 'agt_test' }, token: { id: 'tok_test', token: 'agt_fixture' }, ownerId: 'hum_owner' });
  assert.ok(packet.includes('https://example.com/agent-gram/agentgram.mjs'));
  const config = JSON.parse(packet.match(/AGENTGRAM_CONFIG_JSON'\n([\s\S]*?)\nAGENTGRAM_CONFIG_JSON/)[1]);
  assert.equal(config.token, 'agt_fixture'); assert.equal(config.owner_id, 'hum_owner'); assert.equal(config.url, 'https://example.com/agent-gram');
  assert.ok(!packet.includes('npm install') && !packet.includes('github.com'));
  assert.throws(() => connectionInstructions({ url: 'https://user:secret@example.com', principal: {}, token: {} }));
});
test('standalone connect verifies identity, saves private config and retries confirmation idempotently', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgram-connect-'));
  let kind = 'agent', identityId = 'agt_fixture', sends = 0;
  const keys = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer agt_fixture_key');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/private/api/v1/me') return res.end(JSON.stringify({ principal: { id: identityId, kind } }));
    if (req.url === '/private/api/v1/inbox?after=0&limit=100') return res.end(JSON.stringify({ items: [], next_cursor: '0', has_more: false }));
    if (req.url === '/private/api/v1/messages') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); assert.deepEqual(body.to, ['hum_owner']);
      keys.push(req.headers['idempotency-key']); sends++;
      return res.end(JSON.stringify({ message: { id: 'msg_connected' }, replayed: sends > 1 }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const config = { url: `http://127.0.0.1:${server.address().port}/private`, principal_id: identityId, token: 'agt_fixture_key', token_id: 'tok_fixture', owner_id: 'hum_owner' };
  const path = join(directory, 'profile', 'config.json');
  let result = await execute(['connect'], JSON.stringify(config), { AGENTGRAM_CONFIG: path });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).connected, true);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(JSON.parse(await readFile(path, 'utf8')).token, config.token);
  result = await execute(['connect'], JSON.stringify(config), { AGENTGRAM_CONFIG: path });
  assert.equal(result.code, 0); assert.deepEqual(keys, ['agentgram-connect-tok_fixture', 'agentgram-connect-tok_fixture']);
  result = await execute(['inbox'], '', { AGENTGRAM_CONFIG: path }); assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), []);
  for (const wrong of ['human', 'other-agent']) {
    kind = wrong === 'human' ? 'owner' : 'agent'; identityId = wrong === 'human' ? config.principal_id : 'agt_other';
    const missing = join(directory, wrong, 'config.json');
    result = await execute(['connect'], JSON.stringify(config), { AGENTGRAM_CONFIG: missing });
    assert.equal(result.code, 1); await assert.rejects(stat(missing));
  }
  assert.equal(sends, 2);
});
