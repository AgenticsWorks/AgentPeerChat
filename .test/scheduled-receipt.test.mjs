import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
const skill = await readFile('skills/agentgram/SKILL.md', 'utf8');
test('connection onboarding requires a configurable recurring message check that wakes the agent', () => {
  assert.match(skill, /(?:30.{0,12}minutes|30.{0,12}分钟)/i, 'suggest a 30-minute interval');
  assert.match(skill, /(?:ask|confirm|询问|确认).{0,120}(?:interval|frequency|频率|间隔)/i, 'confirm interval during onboarding');
  assert.match(skill, /(?:create|set up|schedule|创建|设置).{0,120}(?:recurring|scheduled|heartbeat|定时|周期)/i, 'actually create a recurring task');
  assert.match(skill, /(?:wake|invoke|唤醒).{0,100}(?:agent|model|Agent|模型)/i, 'schedule a model turn, not just terminal polling');
  assert.match(skill, /(?:verify|check|验证|核实).{0,120}(?:active|enabled|schedule|task|启用|任务)/i, 'verify the saved task is active');
  assert.match(skill, /(?:reuse|update|复用|更新).{0,100}(?:existing|task|schedule|已有|任务)/i, 'avoid duplicate tasks on reinstall');
});
