import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';

test('file and stdin messages preserve text and JSON values without shell parsing', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentpeerchat-input-')), requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const value = JSON.parse(body); requests.push(value);
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    assert.ok(req.headers['idempotency-key']);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({message: {id: 'msg_fixture', ...value}}));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {await new Promise(done => server.close(done)); await rm(root, {recursive: true, force: true});});
  const env = {...process.env, NODE_USE_ENV_PROXY: '0', AGENTPEERCHAT_CONFIG: '', AGENTPEERCHAT_URL: `http://127.0.0.1:${server.address().port}`, AGENTPEERCHAT_TOKEN: 'fixture-key'};
  for (const name of Object.keys(env)) if (/^(AGENTGRAM_|AGENTPENPAL_)/.test(name)) delete env[name];
  async function run(command, source, input = '', extra = [], executable = 'cli/agentpeerchat.mjs') {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [resolve(executable), command, 'thr_fixture', source, ...extra], {env});
      let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
      child.stdin.on('error', () => {}); child.on('error', fail); child.on('close', code => done({code, stdout, stderr})); child.stdin.end(input);
    });
  }
  const text = 'Hello 世界\n"quoted" $HOME `literal` \\ path\n', path = join(root, 'content with spaces.txt');
  await writeFile(path, text);
  for (const source of [path, '-']) {
    const result = await run('send-file', source, text); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).message.content, text);
  }
  for (const value of [{nested: ['汉字', true, null]}, [1, 2], null, false, 0, 'scalar']) {
    const result = await run('json-file', '-', JSON.stringify(value)); assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout).message.content, value);
  }
  await writeFile(path, '{\n "from": "file"\n}\n'); assert.equal((await run('json-file', path)).code, 0);
  for (const executable of ['dist/cli/agentpeerchat.mjs', 'public/agentpeerchat.mjs', 'public/agentgram.mjs']) {
    const result = await run('json-file', '-', '{"standalone":true}', [], executable);
    assert.equal(result.code, 0, executable + ': ' + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).message.content, {standalone:true});
  }
  const before = requests.length;
  for (const [command, input] of [['json-file', '{invalid'], ['json-file', '"' + 'a'.repeat(32767) + '"'], ['json-file', ' '.repeat(65537)], ['send-file', ' '], ['send-file', '汉'.repeat(5462)], ['send-file', Buffer.from([0xff])], ['send-file', '\0'.repeat(16384)]]) {
    const result = await run(command, '-', input); assert.equal(result.code, 1, result.stdout); assert.ok(result.stderr);
  }
  assert.equal((await run('json-file', path, '', ['-'])).code, 1);
  assert.equal((await run('send-file', join(root, 'missing'))).code, 1);
  assert.equal(requests.length, before, 'invalid input must fail before any network request');
  assert.equal((await run('send-file', '-', 'a'.repeat(16384))).code, 0);
  assert.equal((await run('json-file', '-', JSON.stringify('a'.repeat(32766)))).code, 0);
});
