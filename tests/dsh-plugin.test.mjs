import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DshMailbox,loadIdentity,dedicatedSessionId,ownProfile,NO_REPLY} from '../integrations/dsh/bridge.mjs';
const identity={url:'http://127.0.0.1:3000',principal_id:'agt_fixture',token:'fixture-private-key'};
function message(id='msg_one'){return {id,thread_id:'thr_one',sender_id:'agt_peer',type:'text',content:'Analyze the quotes.'};}
async function fixture(t,{pending=[message()],failReply=false,failAck=false,runTask=async()=> 'Meadow costs 367.40; Harbor costs 381.70.'}={}){
 const root=await mkdtemp(join(tmpdir(),'apc-dsh-'));const controller=new AbortController();const sends=[],acks=[];let work=0;
 const request=async(url,options)=>{
  assert.equal(options.token,identity.token);const path=new URL(url).pathname;
  if(path.endsWith('/me'))return {principal:{id:identity.principal_id,kind:'agent'}};
  if(path.endsWith('/receiver/lease'))return options.method==='DELETE'?{released:true}:{acquired:true,fence:'fixture-lease'};
  if(path.endsWith('/inbox'))return {items:pending,has_more:false};
  if(path.includes('/threads/'))return {thread:{id:'thr_one',title:'Trip'}};
  if(path.endsWith('/messages')){sends.push(options);if(failReply)throw Error('uncertain reply');return {message:{id:'msg_reply'}};}
  if(path.endsWith('/ack')){if(failAck)throw Error('uncertain ack');acks.push(path);pending=[];return {ok:true};}
  throw Error(path);
 };
 const bridge=new DshMailbox({identity,root,signal:controller.signal,request,runTask:async task=>{work++;return runTask(task);}});
 t.after(async()=>{controller.abort();clearTimeout(bridge.retry);await bridge.current;await rm(root,{recursive:true,force:true});});
 return {root,controller,bridge,sends,acks,get work(){return work;},replyWorks(){failReply=false;},ackWorks(){failAck=false;}};
}
test('DSH replies before ACK and persists the exact reply privately',async t=>{
 const f=await fixture(t);await f.bridge.trigger();assert.equal(f.work,1);assert.equal(f.sends.length,1);assert.equal(f.acks.length,1);
 assert.equal(f.sends[0].body.reply_to,'msg_one');assert.equal(f.sends[0].idempotencyKey,'dsh-reply-msg_one');
 assert.equal((await stat(join(f.root,'receipts/msg_one.json'))).mode&0o777,0o600);
 assert.ok(!JSON.stringify(f.bridge.status).includes(identity.token));
});
test('an offline start recovers through the same channel before starting model work',async t=>{
 const f=await fixture(t);const request=f.bridge.request;let offline=true;
 f.bridge.request=async(...args)=>{if(offline)throw Error('Host network is offline');return request(...args);};
 f.bridge.notify=async({onWork})=>{
  await f.bridge.trigger();assert.equal(f.work,0);assert.equal(f.acks.length,0);
  clearTimeout(f.bridge.retry);f.bridge.retry=null;offline=false;await onWork();f.controller.abort();
 };
 await f.bridge.start();assert.equal(f.work,1);assert.equal(f.acks.length,1);assert.equal(f.bridge.status.connected,false);
});
test('uncertain sends and ACKs reuse the persisted result without rerunning DSH',async t=>{
 for(const fail of ['failReply','failAck']){
  const f=await fixture(t,{[fail]:true});await f.bridge.trigger();assert.equal(f.acks.length,0);assert.equal(f.work,1);
  clearTimeout(f.bridge.retry);f.bridge.retry=null;f.replyWorks();f.ackWorks();await f.bridge.trigger();
  assert.equal(f.work,1);assert.equal(f.acks.length,1);assert.deepEqual(f.sends[0].body,f.sends.at(-1).body);
  assert.equal(f.sends[0].idempotencyKey,f.sends.at(-1).idempotencyKey);
 }
});
test('a failed, empty or oversized DSH answer never ACKs the inbound work',async t=>{
 for(const runTask of [async()=>{throw Error('model failure');},async()=>'',async()=> 'a'.repeat(16385)]){
  const f=await fixture(t,{runTask});await f.bridge.trigger();assert.equal(f.sends.length,0);assert.equal(f.acks.length,0);assert.ok(f.bridge.status.last_error);
 }
});
test('completion-only confirmations are ACKed silently, including a retry after restart',async t=>{
 const f=await fixture(t,{failAck:true,runTask:async()=>NO_REPLY});await f.bridge.trigger();
 assert.equal(f.work,1);assert.equal(f.sends.length,0);assert.equal(f.acks.length,0);
 clearTimeout(f.bridge.retry);f.bridge.retry=null;f.ackWorks();
 const restarted=new DshMailbox({...f.bridge,runTask:async()=>{throw Error('Must reuse the durable disposition.');}});
 await restarted.trigger();assert.equal(f.work,1);assert.equal(f.sends.length,0);assert.equal(f.acks.length,1);
});
test('bursts coalesce without overlapping model turns and abort keeps work pending',async t=>{
 let active=0,max=0;const f=await fixture(t,{runTask:async()=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,30));active--;return 'Done';}});
 await Promise.all([f.bridge.trigger(),f.bridge.trigger(),f.bridge.trigger()]);assert.equal(max,1);assert.equal(f.work,1);
 const stopped=await fixture(t,{runTask:async()=>{stopped.controller.abort();return 'Result';}});await stopped.bridge.trigger();assert.equal(stopped.acks.length,0);assert.equal(stopped.sends.length,0);
});
test('identity privacy and exclusive ownership are enforced; session IDs bind URL and Agent',async t=>{
 const root=await mkdtemp(join(tmpdir(),'apc-dsh-private-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'profile.json');await writeFile(file,JSON.stringify(identity),{mode:0o600});assert.deepEqual(await loadIdentity(file),identity);
 assert.equal(dedicatedSessionId(identity),dedicatedSessionId({...identity,token:'rotated'}));assert.notEqual(dedicatedSessionId(identity),dedicatedSessionId({...identity,principal_id:'agt_other'}));
 const release=await ownProfile(join(root,'lock'));await assert.rejects(ownProfile(join(root,'lock')),/already owns/);await release();const second=await ownProfile(join(root,'lock'));await second();
 await writeFile(file,JSON.stringify({...identity,url:'https://user:secret@example.com'}));await assert.rejects(loadIdentity(file),/HTTPS/);
});
test('DSH dispatches the shared scheduled outbox independently of mailbox/model work',async t=>{
 const f=await fixture(t,{pending:[]});let dispatches=0;const errors=[];
 const bridge=new DshMailbox({...f.bridge,
  notify:async({signal})=>new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true})),
  dispatchScheduled:async()=>{dispatches++;if(dispatches===1)throw Error('Offline send');f.controller.abort();},
  onError:error=>errors.push(error.message)
 });
 await bridge.start();assert.equal(dispatches,2);assert.equal(f.work,0);assert.equal(errors.length,1);assert.equal(bridge.status.scheduled_dispatch,true);
});
