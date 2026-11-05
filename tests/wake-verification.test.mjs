import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {SQLiteDatabase} from '../server/sqlite.mjs';

const built=await build({entryPoints:['src/wake-verification.ts'],bundle:true,format:'esm',platform:'node',write:false});
const {WakeVerification}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
async function fixture(t){
 const db=new SQLiteDatabase(':memory:');t.after(()=>db.close());
 for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile('migrations/'+file,'utf8'));
 await db.exec("INSERT INTO principals(id,name,kind) VALUES ('owner','Owner','owner'),('agent','Grok Bot','agent'),('other','Other','agent')");
 const values=new Map(),storage={async get(key){return structuredClone(values.get(key));},async put(key,value){values.set(key,structuredClone(value));}};
 const env={DB:db},agent={id:'agent',name:'Grok Bot',kind:'agent',active:1};
 const create=()=>new WakeVerification(storage,env),verify=create();
 return {db,storage,agent,verify,create,
  async reply(message,{sender='agent',answer='714',replyTo=message.message_id}={}){
   const id=crypto.randomUUID();await db.prepare("INSERT INTO messages(id,thread_id,sender_id,type,content,idempotency_key,request_hash,reply_to) VALUES (?,?,?,'text',?,?,?,?)")
    .bind(id,message.thread_id,sender,JSON.stringify(answer),id,id,replyTo).run();
  },
  async ack(message){await db.prepare("UPDATE deliveries SET acked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE recipient_id='agent' AND message_seq=(SELECT seq FROM messages WHERE id=?)").bind(message.message_id).run();},
  async count(){return (await db.prepare("SELECT count(*) n FROM messages WHERE sender_id='owner'").first()).n;}
 };
}

test('verification needs the target Agent’s correct correlated reply and explicit ACK; HTTP acceptance is not evidence',async t=>{
 const f=await fixture(t);assert.equal(await f.verify.status('agent'),null);
 const message=await f.verify.start(f.agent,'owner','first');assert.equal(message.state,'waiting');
 await f.reply(message,{sender:'other'});await f.reply(message,{answer:'Started processing'});await f.reply(message,{replyTo:null});
 assert.equal((await f.verify.status('agent')).state,'waiting');
 await f.reply(message);assert.equal((await f.verify.status('agent')).state,'replied');
 const pending=await f.db.prepare('SELECT acked_at FROM deliveries').first();assert.equal(pending.acked_at,null);
 await f.ack(message);const complete=await f.verify.status('agent');assert.equal(complete.state,'verified');
 assert.ok(complete.reply_at);assert.ok(complete.acked_at);assert.equal(await f.verify.status('other'),null);
});

test('ACK alone remains unverified; concurrent clicks, restarts and failed insert retries preserve one test',async t=>{
 const f=await fixture(t);
 const results=await Promise.all([f.verify.start(f.agent,'owner','first'),f.verify.start(f.agent,'owner','second')]);
 assert.equal(results[0].message_id,results[1].message_id);assert.equal(await f.count(),1);
 await f.ack(results[0]);assert.equal((await f.create().status('agent')).state,'acked');
 assert.equal((await f.create().start(f.agent,'owner','retry')).message_id,results[0].message_id);
 await assert.rejects(()=>f.verify.start({...f.agent,id:'other'},'owner','wrong'),/identity mismatch/);
 // Simulate a failed D1 insert after durable test reservation, then restart.
 await f.verify.reset();const original=f.db.batch.bind(f.db);let fail=true;
 f.db.batch=async statements=>{if(fail){fail=false;throw Error('simulated unavailable DB');}return original(statements);};
 await assert.rejects(()=>f.verify.start(f.agent,'owner','failed'),/unavailable/);
 const reserved=await f.verify.status('agent');const recovered=await f.create().start(f.agent,'owner','retry');
 assert.equal(reserved.message_id,recovered.message_id);assert.equal(await f.count(),2);
});

test('credential rotation clears verification; older replies and late idempotent retries do not verify or replace a new test',async t=>{
 const f=await fixture(t),first=await f.verify.start(f.agent,'owner','first');
 await f.reply(first);await f.ack(first);assert.equal((await f.verify.status('agent')).state,'verified');
 const second=await f.verify.start(f.agent,'owner','second');assert.notEqual(second.message_id,first.message_id);
 assert.equal((await f.verify.start(f.agent,'owner','first')).message_id,second.message_id);assert.equal(await f.count(),2);
 await f.reply(second);await f.ack(second);
 assert.equal((await f.verify.start(f.agent,'owner','first')).message_id,second.message_id);assert.equal(await f.count(),2);
 await f.verify.reset();assert.equal(await f.verify.status('agent'),null);
 const replacement=await f.verify.start(f.agent,'owner','first');assert.notEqual(replacement.message_id,first.message_id);
 assert.equal(replacement.state,'waiting');assert.equal(await f.count(),3);
});
