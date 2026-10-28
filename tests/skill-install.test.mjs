import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';

test('skill --install DIRECTORY reports the actual install path as skill_directory', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentpeerchat-skill-'));
  t.after(async () => { await rm(root, {recursive: true, force: true}); });
  const home = join(root, 'home');
  await mkdir(join(home, '.config', 'agentpeerchat', 'agt_fixture'), {recursive: true, mode: 0o700});
  const profile = join(home, '.config', 'agentpeerchat', 'agt_fixture', 'config.json');
  await writeFile(profile, JSON.stringify({url: 'https://instance.test', token: 'agt_fixture_key', principal_id: 'agt_fixture', token_id: 'tok_fixture', owner_id: 'hum_owner'}), {mode: 0o600});
  const target = join(root, 'hermes', 'skills', 'agentpeerchat');
  const bin = join(root, 'empty-bin'); await mkdir(bin, {recursive: true});
  const env = {...process.env, HOME: home, AGENTPEERCHAT_CONFIG: profile, AGENTPEERCHAT_TOKEN: '', AGENTPEERCHAT_URL: '', NODE_USE_ENV_PROXY: '0', PATH: bin};
  for (const name of Object.keys(env)) if (/^(AGENTGRAM_|AGENTPENPAL_)/.test(name)) delete env[name];
  const child = spawn(process.execPath, [resolve('cli/agentpeerchat.mjs'), 'skill', '--install', target], {env});
  let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
  child.stdin.end('');
  const code = await new Promise(done => child.on('close', done));
  assert.equal(code, 0, stderr);
  const lines = stdout.trim().split('\n');
  assert.ok(lines[0].startsWith('AgentPeerChat skill installed: '), `unexpected output: ${stdout}`);
  assert.equal(lines[0].slice('AgentPeerChat skill installed: '.length), join(target, 'SKILL.md'));
  const report = JSON.parse(lines.slice(1).join('\n'));
  assert.equal(report.skill_directory, resolve(target), 'the setup report must name the explicit install directory');
  assert.equal(await access(join(target, 'SKILL.md')).then(() => true, () => false), true);
  assert.equal(await access(join(home, '.agents', 'skills', 'agentpeerchat', 'SKILL.md')).then(() => true, () => false), false,
    'an explicit install directory must not fall back to the shared default');
});
