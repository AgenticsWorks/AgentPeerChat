import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { SQLiteDatabase } from '../server/sqlite.mjs';
import { createBridge } from '../scripts/runtime.mjs';
import { chatName, chatsForPerspective } from '../public/chat-presentation.js';
const bundle=await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',write:false});
const worker=(await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
async function fixture(t) {
 const db=new SQLiteDatabase(':memory:');t.after(()=>db.close());for(const f of (await readdir('migrations')).sort())await db.exec(await readFile('migrations/'+f,'utf8'));
 const fetchImpl=(url,options)=>worker.fetch(new Request(url,options),{DB:db,SETUP_SECRET:'a-test-setup-secret-with-32-characters',ASSETS:{fetch:()=>new Response('asset')}});
 let owner;
 async function api(path,body,key=owner,method=body?'POST':'GET') { const r=await fetchImpl('https://mail.test/api/v1'+path,{method,headers:{...(key?{Authorization:`Bearer ${key}`} :{}),...(body?{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()}: {})},body:body?JSON.stringify(body):undefined});assert.ok(r.ok, `${path}: ${r.status}`);return r.json(); }
 owner=(await api('/setup',{name:'我',setup_secret:'a-test-setup-secret-with-32-characters'})).access_key;
 const a=await api('/agents',{name:'小舟'}),b=await api('/agents',{name:'阿岚'});
 const thread=(await api('/threads',{title:'日常讨论',members:[a.principal.id,b.principal.id]})).thread;
 const config=agent=>({url:'https://mail.test',token:agent.token.token,principal_id:agent.principal.id});
 return {api,a,b,thread,fetchImpl,config};
}
test('runtime handles human question and explicit Agent handoff without unending peer replies',async t=>{
 const f=await fixture(t);let aCalls=0,bCalls=0;
 const A=createBridge({config:f.config(f.a),fetchImpl:f.fetchImpl,generate:async()=>{aCalls++;return aCalls===1?{reply:'我问一下阿岚。',handoff:{to:f.b.principal.id,message:'@阿岚，2 加 3 是多少？'}}:{reply:'结论是 5。',handoff:null};}});
 const B=createBridge({config:f.config(f.b),fetchImpl:f.fetchImpl,generate:async()=>{bCalls++;return {reply:'@小舟 2 加 3 是 5。',handoff:null};}});
 await f.api('/messages',{thread_id:f.thread.id,type:'text',content:'@小舟 请问一下阿岚，2 加 3 是多少。'});
 await A.tick();await B.tick();await A.tick();await B.tick();await A.tick();
 assert.equal(aCalls,2);assert.equal(bCalls,1);
 const history=await f.api('/threads/'+f.thread.id);assert.ok(history.items.some(m=>m.content==='结论是 5。'));assert.ok(history.items.some(m=>m.content==='@阿岚 2 加 3 是多少？'));
 assert.equal((await f.api('/inbox',undefined,f.a.token.token)).items.length,0);
 assert.equal((await f.api('/inbox',undefined,f.b.token.token)).items.length,0);
});
test('runtime retains exact response for send/ack retry and never acknowledges failed generation',async t=>{
 const f=await fixture(t);const journal={};let calls=0,failAck=true;
 const message=(await f.api('/messages',{thread_id:f.thread.id,type:'text',content:'@小舟 你好'})).message;
 const bridge=createBridge({config:f.config(f.a),journal,fetchImpl:async(url,opts)=>{if(url.endsWith('/ack')&&failAck){failAck=false;throw new Error('Disconnected');}return f.fetchImpl(url,opts);},generate:async()=>{calls++;return {reply:'你好，我是小舟。',handoff:null};}});
 await assert.rejects(bridge.tick(),/Disconnected/);assert.ok(journal[message.id]);await bridge.tick();assert.equal(calls,1);
 const history=await f.api('/threads/'+f.thread.id);assert.equal(history.items.filter(m=>m.content==='你好，我是小舟。').length,1);
 const second=(await f.api('/messages',{thread_id:f.thread.id,type:'text',content:'@小舟 再问一个问题'})).message;
 const failing=createBridge({config:f.config(f.a),fetchImpl:f.fetchImpl,generate:async()=>{throw new Error('Model unavailable');}});await assert.rejects(failing.tick());
 const receipts=(await f.api('/messages/'+second.id)).receipts;assert.equal(receipts.find(r=>r.recipient_id===f.a.principal.id).acked_at,null);
});
test('chat perspectives change observation only, and direct names use people rather than implementation labels',()=>{
 const thread={title:'Stored title',kind:'direct',participants:[{id:'you',name:'我'},{id:'bot',name:'小舟'}]};
 assert.equal(chatName(thread,'you'),'小舟');assert.equal(chatName(thread,'owner'),'我、小舟');
 assert.equal(chatsForPerspective([thread],'bot','owner').length,1);assert.equal(chatsForPerspective([thread],'mine','owner').length,0);
});
test('Agent direct questions need no mentions, and completed peer answers can stop without another reply',async t=>{
 const f=await fixture(t);let calls=0;
 const B=createBridge({config:f.config(f.b),fetchImpl:f.fetchImpl,generate:async()=>{calls++;return {reply:'8。',handoff:null};}});
 const A=createBridge({config:f.config(f.a),fetchImpl:f.fetchImpl,generate:async()=>({reply:null,handoff:null})});
 const sent=(await f.api('/messages',{to:[f.b.principal.id],type:'text',content:'4 加 4 是多少？'},f.a.token.token)).message;
 await B.tick();await A.tick();await B.tick();assert.equal(calls,1);
 const history=await f.api('/threads/'+sent.thread_id);assert.equal(history.items.length,2);assert.equal(history.items[1].content,'8。');
 assert.equal((await f.api('/inbox',undefined,f.a.token.token)).items.length,0);
});
test('idle reply listeners use one inbox request per poll and still reject revoked access',async t=>{
 const f=await fixture(t);let requests=0;
 const bridge=createBridge({config:f.config(f.a),fetchImpl:async(url,opts)=>{requests++;return f.fetchImpl(url,opts);},generate:async()=>{throw new Error('Idle listeners must not call a model.');}});
 await bridge.tick();assert.equal(requests,2);
 await bridge.tick();await bridge.tick();assert.equal(requests,4);
 await f.api('/principals/'+f.a.principal.id,{active:false},undefined,'PATCH');
 await assert.rejects(bridge.tick(),/Mailbox request failed \(401\)/);
});
