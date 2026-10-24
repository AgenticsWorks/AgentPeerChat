import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {automation,interval,runtimeRecipe} from '../scripts/automation.mjs';

test('recurring intervals reject invalid and dangerously frequent schedules',()=>{
  assert.equal(interval(),1800);assert.equal(interval('1h'),3600);
  for(const value of ['1s','0m','Infinity','9999999999h','30m\n','-1h'])assert.throws(()=>interval(value));
});

test('listener wakes only for work, preserves failed membership discovery, excludes concurrent turns and reports failure',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agentpeerchat-automation-')),profile=join(root,'profile.json'),state=profile+'.automation',calls=[];
  let pending=[],threads=[],sent=new Map(),uncertain=0,identityId='agt_fixture',probeSupported=true,probeStatus=200;
  const server=createServer(async(req,res)=>{
    calls.push(req.url);assert.equal(req.headers.authorization,'Bearer private-fixture-key');
    const finish=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
    if(req.url==='/api/v1/probe')return finish(probeSupported?{agent:{id:identityId,name:'Peer'},pending:pending.length>0,membership_cursor:String(threads.length)}:{error:{message:'Not found'}},probeSupported?probeStatus:404);
    if(req.url==='/api/v1/me')return finish({principal:{id:identityId,name:'Peer',kind:'agent'}});
    if(req.url.startsWith('/api/v1/inbox'))return finish({items:pending,next_cursor:'0',has_more:false});
    if(req.url.startsWith('/api/v1/threads?'))return finish({items:threads,next_cursor:'0',has_more:false});
    if(req.url==='/api/v1/threads/thr_pair?after=0&limit=100')return finish({thread:{id:'thr_pair'},items:[],next_cursor:'0',has_more:false});
    if(req.url==='/api/v1/messages/msg_pending')return finish({receipts:[{recipient_id:'agt_fixture',acked_at:null}]});
    if(req.url==='/api/v1/messages/msg_context')return finish({message:{id:'msg_context',thread_id:'thr_pair'}});
    if(req.url==='/api/v1/messages'){
      let body='';for await(const c of req)body+=c;const content=JSON.parse(body).content,key=req.headers['idempotency-key'];
      if(!sent.has(key))sent.set(key,{id:'msg_'+sent.size,thread_id:JSON.parse(body).thread_id,reply_to:JSON.parse(body).reply_to,content});
      if(uncertain){uncertain--;return finish({error:{message:'Transient response failure'}},503);}
      return finish({message:sent.get(key),replayed:false});
    }
    finish({error:{message:'Not found'}},404);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url='http://127.0.0.1:'+server.address().port,cli=resolve('cli/agentpeerchat.mjs'),env={...process.env,AGENTPEERCHAT_CONFIG:profile,NODE_USE_ENV_PROXY:'0'};
  for(const name of Object.keys(env))if(/^(AGENTGRAM_|AGENTPENPAL_|AGENTPEERCHAT_)/.test(name)&&name!=='AGENTPEERCHAT_CONFIG')delete env[name];
  await writeFile(profile,JSON.stringify({url,principal_id:'agt_fixture',token:'private-fixture-key'}),{mode:0o600});await mkdir(state);
  const runner=join(root,'runner.mjs');await writeFile(runner,`import {writeFile,readFile} from 'node:fs/promises';let prompt='';for await(const c of process.stdin)prompt+=c;await writeFile(${JSON.stringify(join(root,'prompt.txt'))},prompt);const mode=await readFile(${JSON.stringify(join(root,'mode'))},'utf8');if(mode==='fail')process.exit(1);if(mode==='denied'){console.log(JSON.stringify({type:'result',is_error:false,permission_denials:[{tool_name:'Bash'}]}));process.exit(0);}if(mode==='slow')await new Promise(r=>setTimeout(r,300));`);
  await writeFile(join(root,'mode'),'ok');await writeFile(join(state,'runner.json'),JSON.stringify({argv:[process.execPath,runner],cwd:root,timeout_seconds:10}));
  await writeFile(join(state,'listener.json'),JSON.stringify({runner_file:join(state,'runner.json'),every_seconds:1800,system:false}));
  const run=(command,args)=>automation(command,args,{cli,env});
  try{
    // Execute the old interactive summary path and the new idle listener against the same fixture.
    const before=calls.length;await promisify(execFile)(process.execPath,[cli,'summary','--once'],{env});const summaryRequests=calls.length-before;
    const idleStart=calls.length;const quiet=await run('listen',['run']);assert.equal(quiet.model_started,false);assert.equal(quiet.success,true);
    assert.equal(summaryRequests,3);assert.deepEqual(calls.slice(idleStart),['/api/v1/probe']);
    console.log('Request-count fixture: previous idle summary = 3 HTTP requests; optimized listener = 1 HTTP request (no context fetch).');
    // Fresh process/status reads after suspension do not rely on in-memory discovery state.
    const againStart=calls.length;await run('listen',['run']);assert.deepEqual(calls.slice(againStart),['/api/v1/probe']);
    probeStatus=401;const deniedStart=calls.length;await assert.rejects(run('listen',['run']),/Runtime failed/);assert.deepEqual(calls.slice(deniedStart),['/api/v1/probe']);probeStatus=200;
    probeSupported=false;const fallbackStart=calls.length;assert.equal((await run('listen',['run'])).success,true);assert.equal(calls.length-fallbackStart,4);probeSupported=true;
    identityId='agt_other';await assert.rejects(run('listen',['run']),/saved profile identity/);identityId='agt_fixture';
    threads=[{id:'thr_new',title:'New group',kind:'group',participants:[]}];await writeFile(join(root,'mode'),'fail');
    await assert.rejects(run('listen',['run']),/Runtime failed/);assert.equal(JSON.parse(await readFile(join(state,'status.json'),'utf8')).success,false);
    await writeFile(join(root,'mode'),'denied');await assert.rejects(run('listen',['run']),/denied required tools/);
    await writeFile(join(root,'mode'),'ok');
    const recipe=JSON.parse(await readFile(join(state,'runner.json'),'utf8'));
    await writeFile(join(state,'runner.json'),JSON.stringify({...recipe,result_protocol:'claude'}));
    await assert.rejects(run('listen',['run']),/did not report successful completion/);
    assert.equal(JSON.parse(await readFile(join(state,'status.json'),'utf8')).success,false);
    assert.equal(calls.some(path=>path.endsWith('/ack')),false);
    await writeFile(join(state,'runner.json'),JSON.stringify(recipe));
    await writeFile(join(root,'mode'),'ok');const discovered=await run('listen',['run']);assert.equal(discovered.model_started,true);assert.equal(discovered.new_chats,1);assert.match(await readFile(join(root,'prompt.txt'),'utf8'),/Membership changed: true/);assert.match(await readFile(join(root,'prompt.txt'),'utf8'),/Do not use summary --wait or polling loops/);
    assert.equal((await run('listen',['run'])).model_started,false);
    assert.equal((await run('schedule',['list'])).automatic_dispatch,false,'saved settings alone do not prove an active timer');
    pending=[{id:'msg_pending',content:'Need analysis'}];await writeFile(join(root,'mode'),'slow');const first=run('listen',['run']);await new Promise(r=>setTimeout(r,30));assert.equal((await run('listen',['run'])).reason,'already_running');await first;
    const replay=await run('listen',['run']);assert.equal(replay.model_started,true,'runner completion must not acknowledge pending work');
    assert.equal(calls.some(path=>path.endsWith('/ack')),false);
    pending=[];assert.equal((await run('listen',['run'])).model_started,false,'acknowledged work stays quiet after restart');
    await writeFile(join(state,'probe.json'),'{corrupt');assert.equal((await run('listen',['run'])).model_started,true,'corrupt discovery cache recovers conservatively');
    const at=new Date(Date.now()-1000).toISOString();
    const one=await run('schedule',['send','thr_pair','Send once','--at',at]);uncertain=3;
    assert.equal((await run('schedule',['flush'])).delivered.length,0);assert.equal(sent.size,1);assert.ok((await run('schedule',['list'])).jobs[0].last_error);
    assert.equal((await run('schedule',['flush'])).delivered.length,1);assert.equal(sent.size,1,'uncertain response must not duplicate remote delivery');assert.equal((await run('schedule',['flush'])).delivered.length,0);
    const cancelled=await run('schedule',['send','thr_pair','Cancel me','--at',at]);await run('schedule',['cancel',cancelled.job.id]);await run('schedule',['flush']);assert.equal(sent.size,1);
    const recurring=await run('schedule',['send','thr_pair','Recurring brief','--at',at,'--every','1h']);await run('schedule',['flush']);assert.equal(sent.size,2);const job=(await run('schedule',['list'])).jobs.find(x=>x.id===recurring.job.id);assert.ok(Date.parse(job.next_at)>Date.now());
    assert.equal((await stat(join(state,'outbox.json'))).mode&0o777,0o600);assert.equal((await stat(join(state,'status.json'))).mode&0o777,0o600);
    assert.equal(JSON.parse(await readFile(profile,'utf8')).token,'private-fixture-key');assert.ok(one.job.id);
    const reply=JSON.parse((await promisify(execFile)(process.execPath,[cli,'reply','msg_context','Analysis with sources'],{env})).stdout);assert.equal(reply.message.thread_id,'thr_pair');assert.equal(reply.message.content,'Analysis with sources');assert.equal(reply.message.reply_to,'msg_context');
    await assert.rejects(run('schedule',['send','thr_pair','Timezone required','--at','2026-10-15T09:00:00']),/timezone/);
  }finally{await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});}
});

test('native runtime recipes resolve absolute executables and reuse saved host configuration',async()=>{
 const env={PATH:process.env.PATH,AGENTPEERCHAT_CODEX_CLI:process.execPath,AGENTPEERCHAT_CLAUDE_CLI:process.execPath};
 const codex=await runtimeRecipe('codex',process.cwd(),env),claude=await runtimeRecipe('claude',process.cwd(),env);
 assert.equal(codex.argv[0],process.execPath);assert.equal(codex.cwd,process.cwd());assert.equal(codex.mode,'native');assert.deepEqual(codex.argv,[process.execPath]);
 assert.equal(codex.result_protocol,'codex');assert.equal(claude.result_protocol,'claude');
 assert.equal(claude.mode,'native');assert.deepEqual(claude.argv,[process.execPath]);
 await assert.rejects(runtimeRecipe('missing',process.cwd(),env),/--runtime/);await assert.rejects(runtimeRecipe('codex',process.cwd(),{PATH:''}),/not installed/);
});

test('listener proof cannot follow a replaced identity or instance at the same profile path',async()=>{
 const root=await mkdtemp(join(tmpdir(),'apc-proof-binding-')),profile=join(root,'identity.json'),state=profile+'.automation';await mkdir(state);
 const identity={url:'http://127.0.0.1:3000',principal_id:'agt_current',token:'private-fixture'};
 try{
  await writeFile(profile,JSON.stringify(identity),{mode:0o600});
  const context={cli:resolve('cli/agentpeerchat.mjs'),env:{...process.env,AGENTPEERCHAT_CONFIG:profile}};
  const proof={url:identity.url,principal_id:identity.principal_id,success:true,acknowledged:1};
  for(const file of ['status.json','last-model.json'])await writeFile(join(state,file),JSON.stringify(proof));
  assert.equal((await automation('listen',['status'],context)).last_model_check.acknowledged,1);
  await writeFile(profile,JSON.stringify({...identity,principal_id:'agt_replaced'}));
  let status=await automation('listen',['status'],context);assert.equal(status.last_model_check,null);assert.equal(status.last_check,null);
  await writeFile(profile,JSON.stringify({...identity,url:'http://127.0.0.1:4000'}));
  status=await automation('listen',['status'],context);assert.equal(status.last_model_check,null);assert.equal(status.last_check,null);
  await writeFile(profile,JSON.stringify({...identity,token:'rotated-key'}));
  assert.equal((await automation('listen',['status'],context)).last_model_check.acknowledged,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a CLI installation cannot compete with the live DSH native channel',async()=>{
 const root=await mkdtemp(join(tmpdir(),'apc-dsh-owner-')),profile=join(root,'identity.json');
 try{
  await writeFile(profile,JSON.stringify({url:'http://127.0.0.1:3000',principal_id:'agt_dsh',token:'private-fixture'}),{mode:0o600});
  await mkdir(profile+'.dsh-plugin');await writeFile(join(profile+'.dsh-plugin','owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});
  await assert.rejects(automation('listen',['install','--runtime','codex'],{cli:resolve('cli/agentpeerchat.mjs'),env:{...process.env,AGENTPEERCHAT_CONFIG:profile}}),/DSH native plugin already owns/);
  await assert.rejects(readFile(join(profile+'.automation','listener.json')),error=>error.code==='ENOENT');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a busy model does not block the independent scheduled outbox',async t=>{
 const root=await mkdtemp(join(tmpdir(),'apc-busy-outbox-')),profile=join(root,'identity.json'),state=profile+'.automation';let sent=0;
 const server=createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/v1/me')return res.end(JSON.stringify({principal:{id:'agt_fixture',kind:'agent'}}));
  if(req.url==='/api/v1/messages'){for await(const _ of req){}sent++;return res.end(JSON.stringify({message:{id:'msg_scheduled'}}));}
  res.statusCode=404;res.end('{}');
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));await rm(root,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+server.address().port;await writeFile(profile,JSON.stringify({url,principal_id:'agt_fixture',token:'private-fixture'}),{mode:0o600});await mkdir(state);
 await writeFile(join(state,'listener.json'),JSON.stringify({every_seconds:1800}));await writeFile(join(state,'lock.json'),JSON.stringify({pid:process.pid}));
 await writeFile(join(state,'outbox.json'),JSON.stringify([{id:'job_due',thread_id:'thr_fixture',content:'Due while the model works',next_at:new Date(Date.now()-1000).toISOString(),profile_url:url,principal_id:'agt_fixture'}]));
 const result=await automation('listen',['run'],{cli:resolve('cli/agentpeerchat.mjs'),env:{...process.env,AGENTPEERCHAT_CONFIG:profile,NODE_USE_ENV_PROXY:'0'}});
 assert.equal(result.skipped,true);assert.equal(sent,1);assert.ok(JSON.parse(await readFile(join(state,'outbox.json'),'utf8'))[0].completed_at);
});
