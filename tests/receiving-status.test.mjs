import {test} from 'node:test';
import assert from 'node:assert/strict';
import {receivingSummary,notificationLabel} from '../public/receiving-status.js';
import {receivingTranslations} from '../public/receiving-locales.js';
import {setLanguage,t} from '../public/i18n.js';
import {readFile} from 'node:fs/promises';

test('summary distinguishes transport from backlog and excludes disabled agents',()=>{
 const agent=(active,state,pending_count)=>({active,notification:{state},pending_count});
 assert.deepEqual(receivingSummary([agent(1,'connected',2),agent(1,'disconnected',0),agent(1,'unknown',1),agent(0,'disabled',9)]),{enabled:3,connected:1,pending:3,unknown:1});
 for(const state of ['connecting','stale','unsupported','disconnected'])assert.notEqual(notificationLabel(state),'Connected');
 assert.equal(notificationLabel('future-state'),'Unknown');
});
test('all receiving strings translate both ways without modifying user values',()=>{
 for(const [zh,en] of Object.entries(receivingTranslations)){
  setLanguage('zh');assert.equal(t(en),zh);
  setLanguage('en');assert.equal(t(zh),en);
 }
 setLanguage('zh');assert.equal(t('Heartbeat {0}','Muse {0}'),'心跳 Muse {0}');setLanguage('en');
});
test('receiving navigation is owner-only and the new page ships with its stylesheet',async()=>{
 const html=await readFile('public/index.html','utf8');
 for(const match of html.matchAll(/<button[^>]*data-view="receiving"[^>]*>/g))assert.match(match[0],/owner-only/);
 assert.match(html,/id="receiving"[^>]*hidden/);assert.match(html,/receiving-status\.css/);
});

test('heartbeats expire independently of socket existence; old sockets are never assumed healthy',async()=>{
 const {build}=await import('esbuild');
 const built=await build({entryPoints:['src/receiving.ts'],bundle:true,format:'esm',platform:'node',write:false});
 const {notificationSnapshot,receivingStatus,recordInboxCheck}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
 const now=1000000;
 assert.equal(notificationSnapshot([],now).state,'disconnected');
 assert.equal(notificationSnapshot([{heartbeat:null,connected:now}],now).state,'connecting');
 assert.equal(notificationSnapshot([{heartbeat:null,connected:NaN}],now).state,'stale');
 assert.equal(notificationSnapshot([{heartbeat:now-120000,connected:now-130000}],now).state,'stale');
 assert.equal(notificationSnapshot([{heartbeat:now-45000,connected:now-130000}],now).state,'connected');
 const {SQLiteDatabase}=await import('../server/sqlite.mjs');
 const {readdir}=await import('node:fs/promises');
 const db=new SQLiteDatabase(':memory:');
 try{
  for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile('migrations/'+file,'utf8'));
  await db.exec("INSERT INTO principals(id,name,kind) VALUES ('slow','Slow','agent'), ('healthy','Healthy','agent')");
  const result=await receivingStatus({DB:db,NOTIFICATIONS:{getByName:id=>({fetch:()=>id==='slow'?new Promise(()=>{}):Promise.resolve(Response.json({state:'connected',connections:1,last_heartbeat_at:new Date().toISOString()}))})}});
  assert.equal(result.items.find(p=>p.id==='slow').notification.state,'unknown');
  assert.equal(result.items.find(p=>p.id==='healthy').notification.state,'connected');
  // Missing observability storage must not reject successful inbox access.
  await db.exec('DROP TABLE agent_receiving_activity');
  await assert.doesNotReject(()=>recordInboxCheck({DB:db},'healthy'));
 }finally{db.close();}
});
