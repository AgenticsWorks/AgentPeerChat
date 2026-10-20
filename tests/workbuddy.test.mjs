import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {onboard,detectRuntime,installSkill} from '../scripts/onboarding.mjs';
import {runtimeRecipe} from '../scripts/automation.mjs';
import {validateRuntimeResult} from '../scripts/runtime-result.mjs';

test('WorkBuddy host selects native tasks even when unrelated model CLIs exist',async()=>{
 assert.equal(await detectRuntime({CODEBUDDY_HOST:'workbuddy-desktop',AGENTPEERCHAT_CODEX_CLI:process.execPath,CODEX_THREAD_ID:'inherited'}),'workbuddy');
 assert.equal(await detectRuntime({PATH:'',WORKBUDDY_CONFIG_DIR:'/some/config'}),null,'a config directory is not a live host');
 await assert.rejects(runtimeRecipe('workbuddy',process.cwd()),/native local task scheduler/);
});

test('WorkBuddy setup preserves identity and interval, emits a stable credential-free task plan and honors manual',async t=>{
 const home=await mkdtemp(join(tmpdir(),'apc-workbuddy-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const profile=join(home,"agent's profile.json"),identity={url:'https://example.test',principal_id:'agt_workbuddy',token:'secret-fixture-do-not-print'};
 await writeFile(profile,JSON.stringify(identity),{mode:0o600});
 const args={profile,cli:resolve('cli/agentpeerchat.mjs'),skillSource:resolve('skills/agentpeerchat/SKILL.md'),runtime:'workbuddy',env:{HOME:home,PATH:'',WORKBUDDY_CONFIG_DIR:join(home,'wb-private'),AGENTPEERCHAT_WORKSPACE:home}};
 const result=await onboard({...args,preference:{mode:'interval',minutes:60}});
 assert.equal(result.status,'native_wake_required');
 assert.equal(result.native_wake.interval_minutes,60);
 assert.equal(result.native_wake.execution,'local');
 assert.equal(result.native_wake.installed,false);
 assert.equal(result.native_wake.verified,false);
 assert.equal(result.native_wake.realtime,'requires_host_wake_adapter');
 assert.equal(result.skill_directory,join(home,'wb-private','skills','agentpeerchat'));
 assert.match(await readFile(join(result.skill_directory,'SKILL.md'),'utf8'),/WorkBuddy/);
 assert.match(result.native_wake.prompt,/agt_workbuddy/);
 assert.match(result.native_wake.prompt,/then ack/);
 assert.ok(!JSON.stringify(result).includes(identity.token));
 assert.deepEqual(JSON.parse(await readFile(profile,'utf8')),identity);
 await assert.rejects(access(profile+'.automation/listener.json'),{code:'ENOENT'});
 const repeat=await onboard({...args,preference:{mode:'auto'}});
 assert.equal(repeat.native_wake.task_key,result.native_wake.task_key);
 assert.equal(repeat.native_wake.interval_minutes,60);
 assert.equal((await onboard({...args,preference:{mode:'manual'}})).status,'manual');
 assert.equal((await onboard(args)).native_wake,undefined);
 const explicit=join(home,'explicit-skill');
 assert.equal(await installSkill({source:args.skillSource,target:explicit,runtime:'workbuddy',env:args.env}),explicit);
});

test('zero exit without a terminal model result cannot prove a successful turn',()=>{
 for(const output of ['', 'Authentication required. Please use /login', '{"type":"system"}\n', 'null\n'])
  assert.throws(()=>validateRuntimeResult(output,'claude'),/did not report successful completion/);
 assert.doesNotThrow(()=>validateRuntimeResult('{"type":"result","subtype":"success","is_error":false}\n','claude'));
 assert.doesNotThrow(()=>validateRuntimeResult('{"type":"turn.completed","usage":{}}\n','codex'));
 assert.throws(()=>validateRuntimeResult('{"type":"result","subtype":"success","is_error":false,"permission_denials":[{}]}','claude'),/denied/);
 assert.throws(()=>validateRuntimeResult('{"type":"turn.completed"}\n{"type":"turn.failed"}','codex'),/failed/);
 assert.doesNotThrow(()=>validateRuntimeResult('',undefined),'legacy custom runners retain their output contract');
});
