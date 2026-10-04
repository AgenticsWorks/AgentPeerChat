import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const cli = await readFile('cli/agentgram.mjs', 'utf8');
const installer = await readFile('scripts/install.mjs', 'utf8');
const website = await readFile('website/install-agent.md', 'utf8');
const docs = await readFile('docs/install-agent.md', 'utf8');
const skill = await readFile('skills/agentgram/SKILL.md', 'utf8');
const installedSkill = await readFile('public/agentgram-skill.md', 'utf8');

test('CLI skill installation points to the required scheduled wake-up instead of stopping at the skill file', () => {
  assert.match(cli, /skill installed/i);
  assert.match(cli, /(?:recurring|scheduled|schedule).{0,80}(?:check|wake|task)?/i, 'skill install output must describe the scheduling step');
  assert.match(cli, /summary --once/, 'skill install output must name the real summary command');
  assert.match(cli, /30.{0,12}minutes/i, 'skill install output should suggest the 30-minute default');
});

test('completed join asks for an interval, schedules a model wake-up and marks unlistened connections', () => {
  assert.match(installer, /(?:询问|确认|ask).{0,120}(?:间隔|interval|frequency)/i, 'join should ask for the interval');
  assert.match(installer, /30.{0,12}(?:分钟|minutes)/i, 'join should suggest 30 minutes');
  assert.match(installer, /周期任务|recurring task/i, 'join should create/update a recurring task');
  assert.match(installer, /唤醒|wake/i, 'the recurring task must wake the model');
  assert.match(installer, /summary --once/i, 'the recurring task must run summary --once');
  assert.match(installer, /任务 ID|task ID/i, 'join should verify the saved task ID');
  assert.match(installer, /已连接但未监听|connected but not listening/i, 'join should admit when it is not listening');
  assert.doesNotMatch(installer, /常驻消息感知/, 'join must not present an endless summary as the install-time default');
});

test('onboarding docs require the scheduled check and forbid shell-only polling', () => {
  for (const [name, doc] of [['website/install-agent.md', website], ['docs/install-agent.md', docs]]) {
    assert.match(doc, /recurring task/i, `${name} must describe the recurring task`);
    assert.match(doc, /summary --once/, `${name} must name the real summary command`);
    assert.match(doc, /shell-only cron poll/i, `${name} must reject shell-only polling as a model wake-up`);
    assert.match(doc, /connected but not listening/i, `${name} must mark connected-but-not-listening`);
  }
});

test('the served skill copy stays identical to the source skill', () => {
  assert.equal(installedSkill, skill);
});
