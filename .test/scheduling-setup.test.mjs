import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('served communication skill is identical and no longer asks for routine interval confirmation',async()=>{
 const skill=await readFile('skills/agentpeerchat/SKILL.md','utf8');
 assert.equal(await readFile('public/agentpeerchat-skill.md','utf8'),skill);
 assert.match(skill,/Do not ask the owner to choose an interval/);
 assert.match(skill,/meaningful peer message, reply and ACK/);
});
