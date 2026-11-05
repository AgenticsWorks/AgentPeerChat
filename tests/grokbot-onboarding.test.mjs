import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {grokbotWakePlan} from '../scripts/native-wake.mjs';
import {connectionPacket} from '../scripts/connection-packet.mjs';

test('Grok native plans preserve identity, stable tasks and a separate fallback without claiming installation',()=>{
 const input={profile:'/private/owner profile.json',cli:'/private/bin/agentpeerchat',skill:'/private/skills/agentpeerchat/SKILL.md',principalId:'agt_fixture',minutes:75};
 const plan=grokbotWakePlan(input);
 assert.equal(plan.task_key,grokbotWakePlan(input).task_key);
 assert.notEqual(plan.task_key,grokbotWakePlan({...input,profile:'/private/another.json'}).task_key);
 assert.equal(plan.fallback.interval_minutes,75);assert.equal(plan.fallback.preserve_existing,true);
 assert.equal(plan.installed,false);assert.equal(plan.verified,false);
 assert.ok(plan.prompt.includes('require principal.id to equal "agt_fixture"'));
 assert.ok(plan.prompt.includes('reply MESSAGE_ID'));assert.ok(plan.prompt.includes('then ack'));
 assert.ok(plan.next.includes('do not replace its cron trigger'));
 assert.ok(plan.next.includes('Routine runs cannot create other Routines'));
 for(const minutes of [0,1441,NaN,2.5])assert.throws(()=>grokbotWakePlan({...input,minutes}));
 assert.throws(()=>grokbotWakePlan({...input,principalId:'unexpected'}));
});

test('copied instructions integrate private owner setup in both languages and respect manual receiving',()=>{
 for(const chinese of [false,true]){
  const packet=connectionPacket({url:'https://instance.test',config:{receiving:{mode:'interval',minutes:75}},chinese});
  assert.ok(packet.includes('agentpeerchat wake setup --runtime grokbot'));
  assert.ok(packet.includes('wake status'));assert.ok(packet.includes('75'));
  assert.ok(packet.includes(chinese?'直接填入页面':'directly into that page'));
  const manual=connectionPacket({url:'https://instance.test',config:{receiving:{mode:'manual'}},chinese});
  assert.ok(!manual.includes('wake setup --runtime grokbot'));
  assert.ok(manual.includes(chinese?'不要创建或启用':'do not create or enable'));
 }
});

test('CLI wake setup uses only authenticated read routes, keeps preferences, never returns server credentials or mints login access',async t=>{
 const root=await mkdtemp(join(tmpdir(),'agentpeerchat-grok-onboarding-'));
 const profile=join(root,'identity.json'),requests=[];
 let supported=true,statusCode=200,setupUrlOverride,principalId='agt_fixture',invalidStatus=false;
 const server=createServer(async(req,res)=>{
  requests.push(req.method+' '+req.url);
  assert.equal(req.headers.authorization,'Bearer private-fixture-access-key');
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/v1/me'){res.end(JSON.stringify({principal:{id:principalId,kind:'agent'}}));return;}
  assert.equal(req.url,'/api/v1/receiver/wake');
  res.statusCode=statusCode;
  res.end(JSON.stringify(statusCode===200?{supported,configured:false,setup_url:setupUrlOverride||url+'/#wake-agent=agt_fixture',source:invalidStatus?{token:'DO-NOT-ECHO-SOURCE-KEY'}:'private',token:'DO-NOT-ECHO-TOP-LEVEL-KEY',wake_webhook:{provider:'grokbot',state:invalidStatus?{token:'DO-NOT-ECHO-STATE-KEY'}:'accepted',url:'DO-NOT-ECHO-URL',token:'DO-NOT-ECHO-ROUTINE-KEY',last_attempt_at:{token:'DO-NOT-ECHO-TIMESTAMP-KEY'}},verification:{state:'verified',message_id:'msg_fixture',thread_id:'thr_fixture',created_at:'2026-11-05T12:00:00.000Z',reply_at:'2026-11-05T12:00:10.000Z',acked_at:invalidStatus?{token:'DO-NOT-ECHO-ACK-KEY'}:'2026-11-05T12:00:11.000Z',token:'DO-NOT-ECHO-PROOF-KEY'}}:{error:{code:'not_found',message:'Unavailable'}}));
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const url='http://127.0.0.1:'+server.address().port;
 await writeFile(profile,JSON.stringify({url,principal_id:'agt_fixture',token:'private-fixture-access-key'}));
 const profileBefore=await readFile(profile,'utf8');
 t.after(async()=>{await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});});
 const env={...process.env,NODE_USE_ENV_PROXY:'0',AGENTPEERCHAT_CONFIG:profile,AGENTPEERCHAT_URL:'',AGENTPEERCHAT_TOKEN:''};
 for(const name of Object.keys(env))if(/^(AGENTGRAM_|AGENTPENPAL_)/.test(name))delete env[name];
 const run=(args,overrides={})=>new Promise((done,fail)=>{
  const child=spawn(process.execPath,[resolve('scripts/agent.mjs'),'wake',...args],{env:{...env,...overrides}});
  let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  child.on('error',fail);child.on('close',code=>done({code,stdout,stderr}));child.stdin.end();
 });
 const setup=['setup','--runtime','grokbot'];
 await writeFile(profile+'.onboarding.json',JSON.stringify({receiving:{mode:'interval',minutes:75},skill_directory:join(root,'installed-skill')}));
 const result=await run(setup);assert.equal(result.code,0,result.stderr);
 const report=JSON.parse(result.stdout);
 assert.equal(report.native_wake.fallback.interval_minutes,75);
 assert.ok(report.native_wake.prompt.includes('installed-skill/SKILL.md'));
 assert.equal(report.native_wake.installed,false);assert.equal(report.native_wake.verified,false);assert.equal(report.status,'native_wake_required');
 assert.deepEqual(report.verification,{state:'verified',message_id:'msg_fixture',thread_id:'thr_fixture',created_at:'2026-11-05T12:00:00.000Z',reply_at:'2026-11-05T12:00:10.000Z',acked_at:'2026-11-05T12:00:11.000Z'});assert.equal(report.source,'private');
 for(const value of ['private-fixture-access-key','DO-NOT-ECHO'])assert.ok(!result.stdout.includes(value));
 assert.deepEqual(requests,['GET /api/v1/me','GET /api/v1/receiver/wake']);
 const plain=await run(['status']);assert.equal(plain.code,0,plain.stderr);assert.equal(JSON.parse(plain.stdout).native_wake,undefined);
 invalidStatus=true;const malformed=await run(['status']);assert.equal(malformed.code,0,malformed.stderr);assert.ok(!malformed.stdout.includes('DO-NOT-ECHO'));assert.equal(JSON.parse(malformed.stdout).wake_webhook.state,'unknown');invalidStatus=false;
 await writeFile(profile+'.onboarding.json',JSON.stringify({receiving:{mode:'manual'}}));
 const manual=JSON.parse((await run(setup)).stdout);assert.equal(manual.status,'manual');assert.equal(manual.native_wake,null);
 await writeFile(profile+'.onboarding.json',JSON.stringify({receiving:{mode:'auto'}}));
 supported=false;
 const unavailable=JSON.parse((await run(setup)).stdout);assert.equal(unavailable.status,'unsupported');assert.equal(unavailable.native_wake,null);
 supported=true;statusCode=404;
 assert.equal(JSON.parse((await run(setup)).stdout).status,'unsupported');
 statusCode=200;setupUrlOverride='https://wrong.test/#wake-agent=agt_fixture';
 assert.equal((await run(setup)).code,1);setupUrlOverride=undefined;
 principalId='agt_wrong';assert.equal((await run(setup)).code,1);principalId='agt_fixture';
 const before=requests.length;
 for(const args of [['setup'],['setup','--runtime','muse'],['status','--token','secret'],['setup','--runtime','grokbot','--url','secret']])assert.equal((await run(args)).code,1);
 assert.equal((await run(setup,{AGENTPEERCHAT_URL:'https://different.test'})).code,1);
 assert.equal(requests.length,before,'invalid arguments or a foreign URL must not make requests');
 assert.equal(await readFile(profile,'utf8'),profileBefore,'setup must not overwrite the saved identity');
 assert.ok(requests.every(request=>request.startsWith('GET ')));
});
