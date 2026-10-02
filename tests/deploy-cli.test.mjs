// These test orchestration against a local Wrangler stub, not a live Cloudflare account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const script = resolve('scripts/deploy-cli.mjs');
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentgram-deploy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'node_modules/wrangler/bin'), { recursive: true });
  await writeFile(join(directory, 'wrangler.jsonc'), JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'fixture', database_id: '' }] }));
  await writeFile(join(directory, 'node_modules/wrangler/bin/wrangler.js'), `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync('calls.jsonl', JSON.stringify(args) + '\\n');
if (args[0] === 'd1' && args[1] === 'create') {
 const path = 'wrangler.jsonc'; const cfg = JSON.parse(fs.readFileSync(path));
 cfg.d1_databases[0].database_id = 'fixture-db-uuid'; fs.writeFileSync(path, JSON.stringify(cfg));
}
if (args[0] === 'd1' && args[1] === 'migrations' && process.env.FAIL_MIGRATION) process.exit(7);
`);
  return directory;
}
function run(directory, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, AGENTGRAM_SETUP_SECRET: '', FAIL_MIGRATION: '', ...extra };
    const child = spawn(process.execPath, [script], { cwd: directory, env });
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
async function calls(directory) {
  try { return (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
test('invalid setup secrets are rejected before provisioning any cloud resources', async t => {
  const directory = await fixture(t);
  let result = await run(directory, { AGENTGRAM_SETUP_SECRET: 'too-short' });
  assert.notEqual(result.code, 0); assert.deepEqual(await calls(directory), []);
  await mkdir(join(directory, '.wrangler'), { recursive: true });
  for (const secret of [null, 123, 'short']) {
    await writeFile(join(directory, '.wrangler/deployment-secrets.json'), JSON.stringify({ SETUP_SECRET: secret }));
    result = await run(directory); assert.notEqual(result.code, 0); assert.deepEqual(await calls(directory), []);
  }
});
test('deploy reuses the database and secret on reruns, preserves private permissions and never prints secrets', async t => {
  const directory = await fixture(t);
  let result = await run(directory); assert.equal(result.code, 0, result.stderr);
  const path = join(directory, '.wrangler/deployment-secrets.json');
  const first = JSON.parse(await readFile(path)); assert.equal(first.SETUP_SECRET.length, 64);
  assert.ok(!result.stdout.includes(first.SETUP_SECRET)); assert.ok(!result.stderr.includes(first.SETUP_SECRET));
  await chmod(path, 0o644); result = await run(directory); assert.equal(result.code, 0);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(await readFile(path)), first);
  const invoked = await calls(directory);
  assert.deepEqual(invoked.map(args => args.slice(0, 2)), [['d1', 'create'], ['d1', 'migrations'], ['deploy', '--secrets-file'], ['d1', 'migrations'], ['deploy', '--secrets-file']]);
  assert.ok(invoked.filter(args => args[1] === 'migrations').every(args => args.includes('DB') && args.includes('--remote')));
});
test('failed migrations stop upload; retry keeps resources and the saved setup secret', async t => {
  const directory = await fixture(t);
  const failed = await run(directory, { FAIL_MIGRATION: '1' }); assert.equal(failed.code, 7);
  const saved = await readFile(join(directory, '.wrangler/deployment-secrets.json'), 'utf8');
  assert.equal((await calls(directory)).some(args => args[0] === 'deploy'), false);
  const retry = await run(directory); assert.equal(retry.code, 0);
  assert.equal(await readFile(join(directory, '.wrangler/deployment-secrets.json'), 'utf8'), saved);
  assert.equal((await calls(directory)).filter(args => args[1] === 'create').length, 1);
});
