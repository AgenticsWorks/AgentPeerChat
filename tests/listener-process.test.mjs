import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {onboard} from '../scripts/onboarding.mjs';
import {automation} from '../scripts/automation.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,timeout=12000){const end=Date.now()+timeout;while(!await f()){assert.ok(Date.now()<end,'Timed out waiting for listener');await wait(80);}}

test('without systemd the installed supervisor wakes a runtime, restarts receiving, dispatches scheduled mail and cleans up', {timeout:60000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'apc-process-')),profile=join(root,'p.json'),state=profile+'.automation',cli=resolve('cli/agentpeerchat.mjs');
 let pending=[];const receipts=new Map(),sent=[],calls=[],sockets=new Set();
 const server=createServer(async(req,res)=>{
  calls.push(req.url);assert.equal(req.headers.authorization,'Bearer private-fixture');res.setHeader('Content-Type','application/json');const done=(v,status=200)=>{res.statusCode=status;res.end(JSON.stringify(v));};
  if(req.url==='/api/v1/me')return done({principal:{id:'agt_fixture',name:'Dots',kind:'agent'}});
  if(req.url==='/api/v1/probe')return done({agent:{id:'agt_fixture'},pending:pending.length>0,membership_cursor:'0'});
  if(req.url==='/api/v1/realtime/ticket')return done({ticket:'wst_fixture'},201);
  if(req.url.startsWith('/api/v1/inbox'))return done({items:pending,has_more:false,next_cursor:'0'});
  if(req.url==='/api/v1/threads/thr_pair?after=0&limit=100')return done({thread:{id:'thr_pair'},items:[]});
  if(req.url==='/api/v1/messages') {let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);sent.push(body);return done({message:{id:'msg_sent'+sent.length}},201);}
  const ack=/^\/api\/v1\/messages\/(msg_\w+)\/ack$/.exec(req.url);
  if(ack){receipts.set(ack[1],new Date().toISOString());pending=pending.filter(m=>m.id!==ack[1]);return done({ok:true});}
  const receipt=/^\/api\/v1\/messages\/(msg_\w+)$/.exec(req.url);if(receipt)return done({receipts:[{recipient_id:'agt_fixture',acked_at:receipts.get(receipt[1])||null}]});
  return done({},404);
 });
 const ws=new WebSocketServer({server,handleProtocols:()=> 'apc-v1'});ws.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('message',d=>{if(d.toString()==='ping')s.send('pong');});s.send(JSON.stringify({type:'ready'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const env={...process.env,AGENTPEERCHAT_CONFIG:profile,NODE_USE_ENV_PROXY:undefined,HTTPS_PROXY:'http://127.0.0.1:1',HTTP_PROXY:'http://127.0.0.1:1',NO_PROXY:'localhost,127.0.0.1,[::1]'};for(const k of Object.keys(env))if(/^(AGENTPEERCHAT|AGENTGRAM|AGENTPENPAL)_/.test(k)&&k!=='AGENTPEERCHAT_CONFIG')delete env[k];
 const fakeBin=join(root,'bin');await mkdir(fakeBin);await writeFile(join(fakeBin,'systemctl'),'#!/bin/sh\nexit 1\n',{mode:0o700});env.PATH=fakeBin+':'+env.PATH;
 const url='http://127.0.0.1:'+server.address().port;await writeFile(profile,JSON.stringify({url,principal_id:'agt_fixture',token:'private-fixture'}),{mode:0o600});
 const runner=join(root,'runner.mjs'),recipe=join(root,'runner.json');await writeFile(runner,`let prompt='';for await(const c of process.stdin)prompt+=c;if(!prompt.includes('agentpeerchat skill'))process.exit(2);const profile=JSON.parse(await(await import('node:fs/promises')).readFile(process.env.AGENTPEERCHAT_CONFIG,'utf8'));const call=async(path,body)=>{const r=await fetch(profile.url+'/api/v1'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+profile.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return r.json();};for(const m of (await call('/inbox')).items){await call('/messages',{thread_id:'thr_pair',type:'text',content:'Supplier lead time is six days longer; add a six-day launch buffer.'});await call('/messages/'+m.id+'/ack',{});}`);
 await writeFile(recipe,JSON.stringify({argv:[process.execPath,runner],cwd:root,timeout_seconds:10}),{mode:0o600});
 const run=(action,args=[])=>automation('listen',[action,...args],{cli,env});let installed=false;
 t.after(async()=>{if(installed)await run('remove');for(const s of sockets)s.terminate();await new Promise(r=>ws.close(r));await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
 const setup=await onboard({profile,cli,skillSource:resolve('skills/agentpeerchat/SKILL.md'),env:{...env,HOME:root,AGENTPEERCHAT_RUNNER_FILE:recipe,AGENTPEERCHAT_SKILL_DIRECTORY:join(root,'skills','agentpeerchat')}});installed=true;assert.equal(setup.status,'receiving_configured');assert.equal(setup.listener.interval_seconds,1800);assert.equal(setup.listener.manager,'process');assert.equal(setup.listener.persistence,'host_lifetime');
 const original=(await run('status')).process.pid;await onboard({profile,cli,skillSource:resolve('skills/agentpeerchat/SKILL.md'),env:{...env,HOME:root,AGENTPEERCHAT_RUNNER_FILE:recipe,AGENTPEERCHAT_SKILL_DIRECTORY:join(root,'skills','agentpeerchat')}});assert.equal((await run('status')).process.pid,original,'repeated setup does not duplicate or restart the listener');
 // Shorten only this isolated delivery fixture to exercise scheduled sending quickly.
 await run('install',['--runner-file',recipe,'--every','30s']);
 await until(async()=> (await run('status')).realtime.connected);assert.equal((await run('status')).enabled,true);
 await until(async()=> (await run('status')).last_check?.success);const count=calls.length;await wait(500);assert.equal(calls.length,count,'idle supervisor must not poll REST');
 pending=[{id:'msg_work',content:'Compare 12-day and 18-day suppliers.'}];for(const s of sockets)s.send(JSON.stringify({type:'mailbox_changed'}));
 await until(async()=> (await run('status')).last_model_check?.acknowledged===1);assert.ok(sent.some(m=>m.content.includes('six-day')));
 const status=await run('status');await run('start');assert.equal((await run('status')).process.pid,status.process.pid,'start must reuse the running supervisor');assert.equal(status.manager,'process');assert.ok(!JSON.stringify(status).includes('private-fixture'));assert.equal((await stat(join(state,'process.json'))).mode&0o777,0o600);
 const worker=status.process.worker_pid;process.kill(worker,'SIGKILL');await until(async()=>{const s=await run('status');return s.process.worker_pid&&s.process.worker_pid!==worker&&s.realtime.connected;});
 for(const s of sockets)s.terminate();await until(()=>sockets.size===0);pending=[{id:'msg_offline',content:'Update received while disconnected.'}];await until(()=>receipts.has('msg_offline'));
 const scheduled=await automation('schedule',['send','thr_pair','Scheduled supplier reminder','--at',new Date(Date.now()+500).toISOString()],{cli,env});assert.equal(scheduled.automatic_dispatch,true);
 try{await until(()=>sent.some(m=>m.content==='Scheduled supplier reminder'),35000);}
 catch(error){
  const current=await run('status'),jobs=(await automation('schedule',['list'],{cli,env})).jobs;
  throw new Error(JSON.stringify({reason:'Scheduled fixture did not dispatch',process:current.process,last_check:current.last_check,last_model_check:current.last_model_check,recent_requests:calls.slice(-15),jobs:jobs.map(j=>({next_at:j.next_at,last_error:j.last_error,completed_at:j.completed_at})),now:new Date().toISOString()}),{cause:error});
 }
 await run('stop');assert.equal((await run('status')).active,false);assert.equal((await run('status')).installed,true);await run('start');await until(async()=> (await run('status')).realtime.connected);
 const stale=JSON.parse(await readFile(join(state,'process.json'),'utf8'));await run('remove');installed=false;assert.equal((await run('status')).active,false);assert.equal((await run('status')).installed,false);assert.equal((await automation('schedule',['list'],{cli,env})).jobs.length,1);await until(()=>{try{process.kill(stale.pid,0);return false;}catch(e){return e.code==='ESRCH';}});
});
