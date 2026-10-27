import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {mentionQuery,resolveMentions} from '../public/chat-composer.js';
import {archivedConversation} from '../public/conversation-view.js';

const origin='https://mention.test';let mf,db,owner,a,b,outsider,thread;
async function call(path,key=owner,body,extra={}){const response=await mf.dispatchFetch(origin+'/api/v1'+path,{method:body?'POST':'GET',...extra,headers:{...(key?{Authorization:'Bearer '+key}:{}),'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID(),...extra.headers},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};}
before(async()=>{
 const bundle=await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'browser',write:false});
 if(process.env.AGENTPEERCHAT_TEST_BACKEND==='sqlite'){
  const {SQLiteDatabase}=await import('../server/sqlite.mjs');db=new SQLiteDatabase(':memory:');const worker=(await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;mf={dispatchFetch:(url,options)=>worker.fetch(new Request(url,options),{DB:db,SETUP_SECRET:'mentions-private-test-secret'}),dispose:()=>db.close()};
 }else{mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'mentions',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-02',d1Databases:{DB:'mentions'},bindings:{SETUP_SECRET:'mentions-private-test-secret'}}]}));db=await mf.getD1Database('DB');}
 for(const f of(await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec((await readFile('migrations/'+f,'utf8')).replaceAll('\n',' '));
 owner=(await call('/setup',null,{name:'Owner',setup_secret:'mentions-private-test-secret'})).data.access_key;
 a=(await call('/agents',owner,{name:'Grok Bot'})).data;b=(await call('/agents',owner,{name:'Muse'})).data;outsider=(await call('/agents',owner,{name:'Not a member'})).data;
 thread=(await call('/threads',owner,{title:'Travel',members:[a.principal.id,b.principal.id]})).data.thread;
});
after(()=>mf?.dispose());
test('mentions notify named members while every member retains the group history',async()=>{
 const result=await call('/messages',owner,{thread_id:thread.id,type:'text',content:'@Muse compare refundable flights.',mentions:[b.principal.id,b.principal.id]});assert.equal(result.status,201);assert.deepEqual(result.data.message.mentions,[b.principal.id]);
 assert.ok((await call('/inbox',b.token.token)).data.items.some(m=>m.id===result.data.message.id));assert.ok(!(await call('/inbox',a.token.token)).data.items.some(m=>m.id===result.data.message.id));
 const history=(await call('/threads/'+thread.id,a.token.token)).data.items;assert.deepEqual(history.find(m=>m.id===result.data.message.id).mentions,[b.principal.id]);
 const overview=(await call('/overview')).data.items.find(m=>m.id===result.data.message.id);assert.deepEqual(overview.mentions,[b.principal.id]);assert.deepEqual((await call('/export')).data.items.find(m=>m.id===result.data.message.id).mentions,[b.principal.id]);
});
test('mentions validate membership, active state, type and idempotency without changing legacy broadcasts',async()=>{
 const baseline=(await call('/threads/'+thread.id)).data.items.length;
 for(const mentions of [null,'Muse',[outsider.principal.id],[(await call('/me')).data.principal.id]])assert.equal((await call('/messages',owner,{thread_id:thread.id,type:'text',content:'invalid',mentions})).status,400);
 assert.equal((await call('/threads/'+thread.id)).data.items.length,baseline);
 const payload={thread_id:thread.id,type:'text',content:'Choose a flight.',mentions:[b.principal.id]},headers={'Idempotency-Key':crypto.randomUUID()};
 const first=await call('/messages',owner,payload,{headers});assert.equal((await call('/messages',owner,payload,{headers})).data.message.id,first.data.message.id);
 assert.equal((await call('/messages',owner,{...payload,mentions:[a.principal.id]},{headers})).status,409);
 const broadcast=(await call('/messages',owner,{thread_id:thread.id,type:'text',content:'A normal group message.',mentions:[]})).data.message;
 for(const agent of[a,b])assert.ok((await call('/inbox',agent.token.token)).data.items.some(m=>m.id===broadcast.id));assert.equal(broadcast.mentions,undefined);
 await call('/principals/'+b.principal.id,owner,{active:false},{method:'PATCH'});assert.equal((await call('/messages',owner,payload,{headers})).status,200,'an identical committed retry survives recipient retirement');
 assert.equal((await call('/messages',owner,payload)).status,400);
});
test('mention input handles Unicode, names with spaces, punctuation and duplicate names without guessing identity',()=>{
 const members=[{id:'a',name:'Grok Bot'},{id:'b',name:'Muse'},{id:'c',name:'阿兰'},{id:'d',name:'Muse'}];
 assert.equal(mentionQuery('email@example.com'),null);assert.equal(mentionQuery('@Gro').query,'Gro');assert.equal(mentionQuery('one\n@阿').query,'阿');
 assert.deepEqual(resolveMentions('@Grok Bot compare; @阿兰，查航班。',members),['a','c']);assert.deepEqual(resolveMentions('@Muse compare',members),[]);assert.deepEqual(resolveMentions('@Muse compare',members,['d']),['d']);assert.deepEqual(resolveMentions('Do not notify @Muser',members),[]);
});
test('retired peers leave the daily chat list without deleting mixed groups or modifying history',()=>{
 const people=[{id:'owner',kind:'owner',active:1},{id:'old',kind:'agent',active:0},{id:'live',kind:'agent',active:1}];
 assert.equal(archivedConversation({kind:'direct',participants:[people[1],people[2]]}),true);
 assert.equal(archivedConversation({kind:'group',participants:people}),false);
 assert.equal(archivedConversation({kind:'group',participants:people.slice(0,2)}),true);
 assert.equal(archivedConversation({kind:'direct',participants:[{...people[1],active:1},people[2]]},people),true);
});
