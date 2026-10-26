import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import {createApplication} from '../server/app.mjs';
import {requestJSON} from '../scripts/client-transport.mjs';
import {drainNative} from '../scripts/native-mailbox.mjs';
import {recoveryRecords,requestRecovery} from '../scripts/mailbox-recovery.mjs';
import {NativeRuntime,readState,workspaceNeedsReview,clearWorkspaceReview} from '../scripts/native-runtime.mjs';
import {DshMailbox} from '../integrations/dsh/bridge.mjs';
import {automation} from '../scripts/automation.mjs';
const built=await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'node',write:false});
const worker=(await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'))).default;
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'apc-recovery-'));
 const app=await createApplication({worker,databasePath:join(root,'test.sqlite'),setupSecret:'isolated-mailbox-recovery-secret',publicUrl:'http://127.0.0.1',assetsDirectory:resolve('public'),migrationsDirectory:resolve('migrations')});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port;
 const call=(path,token,body,extra={})=>requestJSON(url+'/api/v1'+path,{token,method:body?'POST':'GET',body,...extra});
 const owner=(await call('/setup',null,{name:'Owner',setup_secret:'isolated-mailbox-recovery-secret'})).access_key;
 const a=await call('/agents',owner,{name:'Receiver'}),b=await call('/agents',owner,{name:'Other sender'});
 const identity={url,principal_id:a.principal.id,token:a.token.token};
 const send=(content,key=owner,thread_id)=>call('/messages',key,{...(thread_id?{thread_id}:{to:[a.principal.id]}),type:'text',content},{send:true});
 const inbox=()=>call('/inbox',identity.token);
 const pending=async()=> (await inbox()).items;
 const reviews=[];t.after(async()=>{for(const id of reviews)await clearWorkspaceReview(root,identity,{id});await app.close();await rm(root,{recursive:true,force:true});});
 return {root,app,identity,b,owner,send,call,inbox,pending,reviews};
}
test('a failed conversation does not starve an independent one; its own later messages remain FIFO across restart',async t=>{
 const f=await fixture(t),first=(await f.send('bad')).message;
 await f.send('dependent',f.owner,first.thread_id);const good=(await f.send('independent',f.b.token.token)).message;
 const order=[];let fails=true,now=0;
 const engine={run:async({message})=>{order.push(message.content);if(message.id===first.id&&fails)throw Error('temporary provider failure');return 'done '+message.content;},close:async()=>{}};
 const one=await drainNative({...f,engine,clock:()=>now});
 assert.deepEqual(order,['bad','independent']);assert.equal(one.acknowledged,1);assert.equal(one.recovery.retrying,1);
 assert.deepEqual((await f.pending()).map(m=>m.content),['bad','dependent']);
 await drainNative({...f,engine,clock:()=>now});assert.equal(order.length,2,'notifications must honor durable backoff');
 const record=(await recoveryRecords(f.root,f.identity))[0];assert.equal(record.attempts,1);assert.equal(record.stage,'execute');
 assert.equal((await stat(join(f.root,'recovery',first.id+'.json'))).mode&0o777,0o600);
 fails=false;now=600000;await drainNative({...f,engine:{...engine},clock:()=>now});
 assert.deepEqual(order,['bad','independent','bad','dependent']);assert.equal((await f.pending()).length,0);
 assert.equal((await recoveryRecords(f.root,f.identity)).length,0);
 assert.equal((await f.call('/messages/'+good.id,f.identity.token)).receipts.find(r=>r.recipient_id===f.identity.principal_id).acked_at!==null,true);
});
test('a blocked first page cannot hide ready messages on later inbox pages',async t=>{
 const f=await fixture(t),first=(await f.send('blocked')).message;
 for(let n=0;n<105;n++)await f.send('dependent '+n,f.owner,first.thread_id);
 await f.send('ready on later page',f.b.token.token);const seen=[];
 const result=await drainNative({...f,engine:{run:async({message})=>{seen.push(message.content);if(message.id===first.id)throw Error('temporary failure');return 'done';},close:async()=>{}},clock:()=>0});
 assert.deepEqual(seen,['blocked','ready on later page']);assert.equal(result.acknowledged,1);
 assert.equal((await f.pending()).length,50); // API default page, not total pending count.
 const count=await f.app.database.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE recipient_id=? AND acked_at IS NULL').bind(f.identity.principal_id).first();assert.equal(count.n,106);
});
test('bounded retries pause without leaking provider details; explicit safe retry preserves the same delivery',async t=>{
 const f=await fixture(t),message=(await f.send('retry me')).message;let now=0,calls=0;
 const engine={run:async()=>{calls++;throw Error('Provider unavailable; PRIVATE_PROVIDER_TOKEN must not be persisted');},close:async()=>{}};
 for(let n=0;n<5;n++){await drainNative({...f,engine,clock:()=>now});now+=600000;}
 let record=(await recoveryRecords(f.root,f.identity))[0];assert.equal(record.status,'paused');assert.equal(record.attempts,5);
 assert.ok(!JSON.stringify(record).includes('PRIVATE_PROVIDER_TOKEN'));
 await drainNative({...f,engine,clock:()=>now});assert.equal(calls,5);
 await requestRecovery(f.root,f.identity,message.id,'retry');
 const recovered=await drainNative({...f,engine:{run:async()=>{calls++;return 'recovered';},close:async()=>{}},clock:()=>now});
 assert.equal(recovered.acknowledged,1);assert.equal(calls,6);
});
test('access failures pause before model execution; invalid saved output cannot rerun tools',async t=>{
 const f=await fixture(t),message=(await f.send('access')).message;let calls=0,blocked=true;
 const request=async(url,options)=>{if(blocked&&url.includes('/threads/'))throw Object.assign(Error('401: access unavailable'),{status:401});return requestJSON(url,options);};
 const engine={run:async()=>{calls++;return 'done';},close:async()=>{}};
 await drainNative({...f,engine,request});assert.equal(calls,0);assert.equal((await recoveryRecords(f.root,f.identity))[0].error_code,'access_required');
 blocked=false;await requestRecovery(f.root,f.identity,message.id,'retry');await drainNative({...f,engine,request});assert.equal(calls,1);
 const long=(await f.send('long result')).message;const output='x'.repeat(16385);
 const oversized={run:async()=>{calls++;return output;},close:async()=>{}};
 await drainNative({...f,engine:oversized});assert.equal(calls,2);
 assert.equal((await readState(join(f.root,'receipts',long.id+'.json'))).content,output);
 await requestRecovery(f.root,f.identity,long.id,'retry');await drainNative({...f,engine:oversized});assert.equal(calls,2);
 assert.equal((await recoveryRecords(f.root,f.identity))[0].error_code,'invalid_saved_reply');assert.equal((await f.pending()).length,1);
});
test('uncertain execution pauses the workspace; reconciliation inspects saved completion without a new turn',async t=>{
 const f=await fixture(t),first=(await f.send('uncertain')).message;f.reviews.push(first.id);
 await f.send('independent',f.b.token.token);let runs=0,inspections=0;
 const engine={workspace:f.root,run:async({checkpoint})=>{runs++;await checkpoint.save({phase:'running'});throw Error('Disconnected after native acceptance');},close:async()=>{}};
 const result=await drainNative({...f,engine});assert.equal(result.recovery.needs_review,1);assert.equal(runs,1);assert.equal(await workspaceNeedsReview(f.root),true);
 await drainNative({...f,engine});assert.equal(runs,1);
 await assert.rejects(requestRecovery(f.root,f.identity,first.id,'retry'),/uncertain/);
 const other=new NativeRuntime({runner:{cwd:f.root,argv:['unused'],result_protocol:'codex'},root:join(f.root,'other'),identity:{...f.identity,principal_id:'agt_other'},spawnPeer:()=>{throw Error('must not launch');}});
 await assert.rejects(other.run({message:{id:'msg_other',thread_id:'thr_other'}}),/uncertain execution/);
 await requestRecovery(f.root,f.identity,first.id,'reconcile');
 const recovered=await drainNative({...f,engine:{workspace:f.root,run:async()=>{runs++;return 'independent completed';},reconcile:async()=>{inspections++;return 'confirmed saved native result';},close:async()=>{}}});
 assert.equal(inspections,1);assert.equal(runs,2);assert.equal(recovered.acknowledged,2);assert.equal(await workspaceNeedsReview(f.root),false);
});
test('unsuccessful reconciliation stays pending, clears its one-shot request and cannot reexecute tools',async t=>{
 const f=await fixture(t),first=(await f.send('uncertain')).message;f.reviews.push(first.id);let runs=0,inspections=0;
 const engine={workspace:f.root,run:async({checkpoint})=>{runs++;await checkpoint.save({phase:'running'});throw Error('interrupted');},reconcile:async()=>{inspections++;throw Error('No confirmed completion');},close:async()=>{}};
 await drainNative({...f,engine});await requestRecovery(f.root,f.identity,first.id,'reconcile');await drainNative({...f,engine});await drainNative({...f,engine});
 assert.equal(runs,1);assert.equal(inspections,1);assert.equal((await f.pending()).length,1);
 const record=(await recoveryRecords(f.root,f.identity))[0];assert.equal(record.status,'needs_review');assert.equal(record.reconcile_requested,undefined);
});
test('a reply or ACK committed before a lost response never reruns model work after restart',async t=>{
 for(const stage of ['reply','ack']){
  const f=await fixture(t);await f.send('calculate');let runs=0,fail=true;
  const request=async(url,options)=>{const result=await requestJSON(url,options);if(fail&&(stage==='reply'?url.endsWith('/messages'):url.endsWith('/ack'))){fail=false;throw Error('Lost response after commit');}return result;};
  const engine={run:async()=>{runs++;return 'Saved exact answer';},close:async()=>{}};
  await drainNative({...f,engine,request,clock:()=>0});
  await drainNative({...f,engine:{run:async()=>{throw Error('Must reuse saved output');},close:async()=>{}},clock:()=>600000});
  assert.equal(runs,1);assert.equal((await f.pending()).length,0);assert.equal((await recoveryRecords(f.root,f.identity)).length,0);
  const replies=await f.app.database.prepare("SELECT COUNT(*) AS n FROM messages WHERE sender_id=? AND content=?").bind(f.identity.principal_id,JSON.stringify('Saved exact answer')).first();assert.equal(replies.n,1);
 }
});
test('DSH uses the same independent-thread retry rules and private status is read-only',async t=>{
 const f=await fixture(t),first=(await f.send('bad')).message;await f.send('good',f.b.token.token);
 const controller=new AbortController();const order=[];
 const bridge=new DshMailbox({identity:f.identity,root:f.root,signal:controller.signal,clock:()=>0,request:requestJSON,runTask:async({message})=>{order.push(message.content);if(message.id===first.id)throw Error('provider failure');return 'done';}});
 t.after(()=>{controller.abort();clearTimeout(bridge.retry);});await bridge.trigger();assert.deepEqual(order,['bad','good']);assert.equal(bridge.status.processed,1);assert.equal(bridge.status.recovery.retrying,1);
 const profile=join(f.root,'identity.json');await writeFile(profile,JSON.stringify(f.identity),{mode:0o600});
 // The same read-only command also works for native CLI receivers.
 const normalRoot=profile+'.automation';const {mkdir,cp}=await import('node:fs/promises');await mkdir(normalRoot);await cp(join(f.root,'recovery'),join(normalRoot,'recovery'),{recursive:true});
 const saved=await readFile(join(normalRoot,'recovery',first.id+'.json'),'utf8');
 const report=await automation('mailbox',['status'],{env:{AGENTPEERCHAT_CONFIG:profile}});
 assert.equal(report.retrying,1);assert.ok(!JSON.stringify(report).includes(f.identity.token));assert.equal(await readFile(join(normalRoot,'recovery',first.id+'.json'),'utf8'),saved);
});
test('operator-confirmed completion resolves an uncertain Claude/DSH result without repeating execution',async t=>{
 const {resolveRecovery}=await import('../scripts/mailbox-recovery.mjs');
 const f=await fixture(t),message=(await f.send('uncertain')).message;f.reviews.push(message.id);let runs=0;
 const engine={workspace:f.root,run:async({checkpoint})=>{runs++;await checkpoint.save({phase:'running'});throw Error('result could not be confirmed');},close:async()=>{}};
 await drainNative({...f,engine});await assert.rejects(resolveRecovery(f.root,f.identity,message.id,''),/nonempty/);
 await resolveRecovery(f.root,f.identity,message.id,'Result checked against the original native transcript.');
 assert.equal(await workspaceNeedsReview(f.root),false);
 const result=await drainNative({...f,engine});assert.equal(runs,1);assert.equal(result.acknowledged,1);assert.equal(result.reused_results,1);assert.ok(result.model_finished_at);
 assert.equal((await f.pending()).length,0);assert.equal((await recoveryRecords(f.root,f.identity)).length,0);
});
test('Codex inspection without a saved completion cannot create a session or start a turn',async t=>{
 const root=await mkdtemp(join(tmpdir(),'apc-reconcile-only-'));t.after(()=>rm(root,{recursive:true,force:true}));const methods=[];
 const engine=new NativeRuntime({root,runner:{cwd:root,argv:['unused'],result_protocol:'codex',timeout_seconds:10},identity:{url:'https://fixture.invalid',principal_id:'agt_fixture'},spawnPeer:()=>({child:{pid:123},listeners:new Set(),send(){},async close(){},async request(method){methods.push(method);if(method==='initialize')return {};throw Error('No other RPC is expected.');}})});
 await assert.rejects(engine.reconcile({message:{id:'msg_one',thread_id:'thr_one'},checkpoint:{phase:'running'}}),/No saved native session/);
 assert.deepEqual(methods,['initialize']);await engine.close();
});
test('Retry-After is retained for durable mailbox backoff and paused work is visible to doctor',async t=>{
 const f=await fixture(t),message=(await f.send('rate limited')).message;
 const engine={run:async()=>{throw Object.assign(Error('429: rate limit'),{status:429,retry_after_ms:120000});},close:async()=>{}};
 await drainNative({...f,engine,clock:()=>0});const record=(await recoveryRecords(f.root,f.identity))[0];assert.equal(Date.parse(record.next_retry_at),120000);
 const {doctor}=await import('../scripts/doctor.mjs');
 const result=await doctor({config:f.identity,token:f.identity.token,url:f.identity.url,request:path=>f.call(path,f.identity.token),listenerStatus:async()=>({installed:true,active:true,enabled:true,recovery:{paused:1,needs_review:0,retrying:0}})});
 assert.equal(result.state,'needs_attention');assert.ok(result.checks.some(c=>c.id==='mailbox_recovery'&&c.status==='fail'));
 assert.equal((await f.pending())[0].id,message.id);
});
test('restart inspects a checkpoint left before failure journaling and does not strand the workspace',async t=>{
 const {writeState,markWorkspaceReview}=await import('../scripts/native-runtime.mjs');
 const f=await fixture(t),message=(await f.send('interrupted before error save')).message;f.reviews.push(message.id);
 await writeState(join(f.root,'receipts',message.id+'.json'),{url:f.identity.url,principal_id:f.identity.principal_id,message_id:message.id,thread_id:message.thread_id,phase:'running'});
 await markWorkspaceReview(f.root,f.identity,message);let inspections=0;
 const result=await drainNative({...f,engine:{workspace:f.root,run:async()=>{throw Error('Must not rerun native tools');},reconcile:async()=>{inspections++;return 'Recovered from exact saved native history';},close:async()=>{}}});
 assert.equal(inspections,1);assert.equal(result.acknowledged,1);assert.equal(await workspaceNeedsReview(f.root),false);
});
test('a due retry is serviced even when a bounded pass left a cursor inside a growing backlog',async t=>{
 const f=await fixture(t),first=(await f.send('retry first')).message;
 for(let n=0;n<23;n++)await f.send('backlog '+n,f.b.token.token);
 let now=0,fails=true;const order=[];
 const engine={run:async({message})=>{order.push(message.content);if(message.id===first.id&&fails)throw Error('temporary failure');return 'done';},close:async()=>{}};
 const one=await drainNative({...f,engine,clock:()=>now});assert.equal(one.scan_incomplete,true);assert.equal(order.length,20);
 fails=false;now=600000;await drainNative({...f,engine,clock:()=>now});assert.equal(order[20],'retry first');
});
test('missing cached output after a delivery failure never permits model reexecution',async t=>{
 const f=await fixture(t),message=(await f.send('completed already')).message;f.reviews.push(message.id);let runs=0,fail=true;
 const request=async(url,options)=>{const result=await requestJSON(url,options);if(fail&&url.endsWith('/messages')){fail=false;throw Error('lost reply response');}return result;};
 await drainNative({...f,engine:{run:async()=>{runs++;return 'Exact completed result';},close:async()=>{}},request,clock:()=>0});
 await rm(join(f.root,'receipts',message.id+'.json'));
 const result=await drainNative({...f,engine:{workspace:f.root,run:async()=>{runs++;return 'Must not repeat tools';},close:async()=>{}},clock:()=>600000});
 assert.equal(runs,1);assert.equal(result.recovery.needs_review,1);assert.equal((await f.pending()).length,1);
});
