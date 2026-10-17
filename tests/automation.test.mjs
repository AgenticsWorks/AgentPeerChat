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
 assert.equal(codex.argv[0],process.execPath);assert.equal(codex.cwd,process.cwd());assert.ok(codex.argv.includes('workspace-write'));assert.equal(codex.argv.at(-1),'-');
 assert.ok(claude.argv.includes('user,project'));assert.ok(claude.argv.includes('dontAsk'));assert.ok(!claude.argv.includes('--dangerously-skip-permissions'));const scoped=await runtimeRecipe('claude',process.cwd(),env,'/absolute/agentpeerchat');assert.ok(scoped.argv.includes('Bash'));assert.ok(scoped.argv.includes('Read'));assert.ok(scoped.argv.includes('Skill'));assert.ok(!claude.argv.includes('--tools'));
 await assert.rejects(runtimeRecipe('missing',process.cwd(),env),/--runtime/);await assert.rejects(runtimeRecipe('codex',process.cwd(),{PATH:''}),/not installed/);
});
