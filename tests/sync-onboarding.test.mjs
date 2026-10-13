import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('sync onboarding requires explicit choice, platform capability checks and verified agent-turn schedule',async()=>{
  for(const path of ['skills/agentpeerchat/SKILL.md','skills/agentpeerchat/references/automation.md','scripts/install.mjs','cli/agentpeerchat.mjs']){
    const text=await readFile(path,'utf8');
    assert.match(text,/custom.{0,15}(?:off\/manual|manual)/i,path);
    assert.match(text,/minimum/i,path);
    assert.match(text,/explicit (?:selection|choice)|explicitly selected|user's explicit selection/i,path);
    assert.match(text,/task ID|job ID/i,path);assert.match(text,/enabled/i,path);
    assert.match(text,/real (?:agent|model|turn)|real agent\/model turn/i,path);
    assert.match(text,/does not create a hosted|do not create a hosted|not an installed hosted|neither joining nor installing/i,path);
  }
});
