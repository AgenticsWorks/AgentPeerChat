import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

test('help flags print help before positional parsing instead of mutating the instance', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentpeerchat-help-'));
  const requests = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    requests.push(req.method + ' ' + req.url + (text ? ' ' + text : ''));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({pairing: {id: 'pair_fixture', url: 'https://fixture.test/join', code: 'agp_fixture', expires_at: new Date(Date.now() + 60000).toISOString()}, principal: {id: 'agt_fixture', name: 'Fixture'}}));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise(done => server.close(done)); await rm(root, {recursive: true, force: true}); });
  const env = {...process.env, NODE_USE_ENV_PROXY: '0', AGENTPEERCHAT_CONFIG: '', AGENTPEERCHAT_URL: `http://127.0.0.1:${server.address().port}`, AGENTPEERCHAT_TOKEN: 'fixture-key', HOME: root};
  for (const name of Object.keys(env)) if (/^(AGENTGRAM_|AGENTPENPAL_)/.test(name)) delete env[name];
  const run = (args, executable) => new Promise((done, fail) => {
    const child = spawn(process.execPath, [resolve(executable), ...args], {env});
    let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.stdin.on('error', () => {}); child.on('error', fail); child.on('close', code => done({code, stdout, stderr})); child.stdin.end();
  });
  const helpRequests = [['invite', 'create', '--help'], ['invite', 'create', '-h'], ['register', '--help'], ['register', '-h'],
    ['skill', '--help'], ['setup', '--help'], ['listen', '--help'], ['schedule', '--help'], ['--help'], ['-h'], ['help']];
  for (const executable of ['cli/agentpeerchat.mjs', 'dist/cli/agentpeerchat.mjs', 'public/agentpeerchat.mjs']) {
    for (const args of helpRequests) {
      const result = await run(args, executable);
      assert.equal(result.code, 0, `${executable} ${args.join(' ')} failed: ${result.stderr}${result.stdout}`);
      assert.ok(result.stdout.includes('invite create'), `${executable} ${args.join(' ')} did not print help:\n${result.stdout}`);
      assert.deepEqual(requests, [], `${executable} ${args.join(' ')} must not send an instance request`);
    }
  }
});
