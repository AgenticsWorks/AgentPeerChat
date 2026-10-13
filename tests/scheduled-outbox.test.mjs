import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {automation} from '../scripts/automation.mjs';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'agentpeerchat-outbox-')),profile=join(root,'profile.json'),queuePath=join(profile+'.automation','outbox.json');
  const requests=[],messages=[],identity={id:'agt_fixture',kind:'agent'};
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    requests.push({path:req.url,authorization:req.headers.authorization,key:req.headers['idempotency-key'],body:body?JSON.parse(body):undefined});
    const finish=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(req.url==='/api/v1/me')return finish({principal:identity});
    if(req.url==='/api/v1/threads/thr_fixture?after=0&limit=100')return finish({items:[],next_cursor:'0',has_more:false});
    if(req.url==='/api/v1/messages'){
      const message={id:'msg_'+messages.length,...JSON.parse(body)};messages.push(message);return finish({message});
    }
    return finish({error:{message:'Not found'}},404);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(async()=>{await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+server.address().port,config={url,principal_id:identity.id,token:'fixture-token'};
  const env={...process.env,NODE_USE_ENV_PROXY:'0'};
  for(const key of Object.keys(env))if(/^(AGENTGRAM_|AGENTPENPAL_|AGENTPEERCHAT_)/.test(key))delete env[key];
  env.AGENTPEERCHAT_CONFIG=profile;
  await writeFile(profile,JSON.stringify(config),{mode:0o600});await mkdir(profile+'.automation');
  return {profile,queuePath,config,env,identity,requests,messages,
    run:(args,overrides={})=>automation('schedule',args,{cli:resolve('cli/agentpeerchat.mjs'),env:{...env,...overrides}}),
    writeQueue:items=>writeFile(queuePath,JSON.stringify(items)),readQueue:async()=>JSON.parse(await readFile(queuePath,'utf8'))};
}
const past=new Date(Date.now()-60_000).toISOString();
const legacyJob=(patch={})=>({id:'job_fixture',thread_id:'thr_fixture',content:'Scheduled fixture',next_at:past,...patch});

test('scheduled text uses the API UTF-8 byte limit and preserves exact boundary content',async t=>{
  const f=await fixture(t);
  for(const content of ['a'.repeat(16385),'界'.repeat(5462),'😀'.repeat(4097),'\0'.repeat(16384),' \n\t']){
    await assert.rejects(f.run(['send','thr_fixture',content,'--at',past]),/16384 UTF-8 bytes/);
    assert.equal(f.requests.length,0,'invalid content is rejected before any API call');
  }
  await assert.rejects(f.readQueue(),{code:'ENOENT'});
  const accepted=['a'.repeat(16384),'界'.repeat(5461)+'a','😀'.repeat(4096)];
  for(const content of accepted){
    const {job}=await f.run(['send','thr_fixture',content,'--at',past]);
    assert.equal(job.content,content);assert.equal(job.profile_url,f.config.url);assert.equal(job.principal_id,f.config.principal_id);
  }
  assert.equal((await f.run(['flush'])).delivered.length,accepted.length);
  assert.deepEqual(f.messages.map(message=>message.content),accepted);
});

test('flush validates the complete active outbox before dispatch and never rewrites corrupt state',async t=>{
  const f=await fixture(t);
  const corrupt=[null,[],{},legacyJob({id:'invalid'}),legacyJob({id:'job_'+'x'.repeat(77)}),
    legacyJob({next_at:'not-a-date'}),legacyJob({next_at:null}),legacyJob({next_at:'2026-02-30T00:00:00.000Z'}),
    legacyJob({thread_id:'not-a-thread'}),legacyJob({thread_id:'thr_'+'x'.repeat(77)}),
    legacyJob({content:null}),legacyJob({content:' '.repeat(5)}),legacyJob({content:'😀'.repeat(4097)}),legacyJob({content:'\0'.repeat(16384)}),
    ...[0,-1,29,86401,30.5,'60',null].map(every_seconds=>legacyJob({every_seconds})),
    legacyJob({cancelled:'false'}),legacyJob({completed_at:'not-a-date'})];
  for(const invalid of corrupt){
    const items=[legacyJob({id:'job_valid'}),invalid];await f.writeQueue(items);
    await assert.rejects(f.run(['flush']),/Invalid scheduled message/);
    assert.deepEqual(await f.readQueue(),items);assert.equal(f.requests.length,0);
    assert.deepEqual((await f.run(['list'])).jobs,items,'corrupt entries remain inspectable');
  }
  const duplicates=[legacyJob(),legacyJob({content:'Different content'})];await f.writeQueue(duplicates);
  await assert.rejects(f.run(['flush']),/Invalid scheduled message identity/);assert.equal(f.requests.length,0);
});

test('legacy jobs remain deliverable and cancellation can recover invalid active content',async t=>{
  const f=await fixture(t),future=new Date(Date.now()+3600_000).toISOString();
  await f.writeQueue([legacyJob({content:'😀'.repeat(4097)}),legacyJob({id:'job_future',next_at:future})]);
  await f.run(['cancel','job_fixture']);
  assert.deepEqual((await f.run(['flush'])).delivered,[]);assert.equal(f.requests.length,0);
  await f.writeQueue([legacyJob(),legacyJob({id:'job_recurring',every_seconds:30}),legacyJob({id:'job_future',next_at:future})]);
  assert.equal((await f.run(['flush'])).delivered.length,2);
  const jobs=await f.readQueue();assert.ok(jobs[0].completed_at);assert.ok(Date.parse(jobs[1].next_at)>Date.now());
  assert.equal(jobs[2].next_at,future);assert.equal(f.messages.length,2);
  const keys=f.requests.filter(request=>request.path==='/api/v1/messages').map(request=>request.key);
  assert.deepEqual(keys,['scheduled-job_fixture-'+past,'scheduled-job_recurring-'+past]);
  assert.deepEqual((await f.run(['flush'])).delivered,[]);
});

test('automation rejects conflicting current and legacy connection overrides without sending',async t=>{
  const f=await fixture(t);await f.writeQueue([legacyJob()]);
  for(const overrides of [{AGENTPEERCHAT_URL:f.config.url+'/other'},{AGENTPEERCHAT_TOKEN:'another-token'},
    {AGENTGRAM_URL:f.config.url+'/other'},{AGENTGRAM_TOKEN:'another-token'},
    {AGENTPENPAL_URL:f.config.url+'/other'},{AGENTPENPAL_TOKEN:'another-token'}]){
    await assert.rejects(f.run(['flush'],overrides),/conflicting URL \/ TOKEN/);
    await assert.rejects(f.run(['send','thr_fixture','New job','--at',past],overrides),/conflicting URL \/ TOKEN/);
    assert.equal(f.requests.length,0);assert.deepEqual(await f.readQueue(),[legacyJob()]);
  }
  assert.equal((await f.run(['flush'],{AGENTPEERCHAT_URL:f.config.url+'/',AGENTPEERCHAT_TOKEN:f.config.token,AGENTGRAM_TOKEN:'ignored-legacy-token'})).delivered.length,1);
  assert.ok(f.requests.every(request=>request.authorization==='Bearer '+f.config.token));
});

test('enqueue and flush require the saved profile identity to match the authenticated identity',async t=>{
  const f=await fixture(t);f.identity.id='agt_other';await f.writeQueue([legacyJob()]);
  await assert.rejects(f.run(['send','thr_fixture','New job','--at',past]),/does not match the saved profile identity/);
  await assert.rejects(f.run(['flush']),/does not match the saved profile identity/);
  assert.deepEqual(await f.readQueue(),[legacyJob()]);assert.equal(f.messages.length,0);
  assert.ok(f.requests.every(request=>request.path==='/api/v1/me'));
});

test('new jobs stay bound to their original principal and instance while token rotation is supported',async t=>{
  const f=await fixture(t),{job}=await f.run(['send','thr_fixture','Bound message','--at',past]);f.requests.length=0;
  await writeFile(f.profile,JSON.stringify({...f.config,principal_id:'agt_other'}));f.identity.id='agt_other';
  await assert.rejects(f.run(['flush']),/different connection profile/);assert.equal(f.requests.length,0);
  await writeFile(f.profile,JSON.stringify({...f.config,url:f.config.url+'/other'}));
  await assert.rejects(f.run(['flush']),/different connection profile/);assert.equal(f.requests.length,0);
  await writeFile(f.profile,JSON.stringify({...f.config,url:f.config.url+'/',token:'rotated-fixture-token'}));f.identity.id=f.config.principal_id;
  assert.equal((await f.run(['flush'])).delivered.length,1);assert.equal(f.messages[0].content,job.content);
  assert.ok(f.requests.every(request=>request.authorization==='Bearer rotated-fixture-token'));
});
