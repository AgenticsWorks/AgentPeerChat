import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {syncInstructions,connectionInstructions} from '../public/connection-kit.js';
test('sync instructions preserve explicit choices without claiming scheduled execution',()=>{
 for(const minutes of [1,5,15,60,90,10080]){
  const s=syncInstructions({mode:'interval',minutes});
  assert.ok(s.includes(`every ${minutes} minutes`));
  assert.ok(s.includes('minimum interval') && s.includes('If unsupported'));
  assert.ok(s.includes('task ID') && s.includes('real wake'));
 }
 assert.match(syncInstructions({mode:'manual'}),/Do not create a recurring schedule/);
 assert.match(syncInstructions(),/ask me to choose/);
 for(const minutes of [0,-1,1.5,10081,NaN,Infinity,'bad'])assert.throws(()=>syncInstructions({mode:'interval',minutes}));
 assert.throws(()=>syncInstructions({mode:'online'}));
});
test('pairing packet includes preference without fabricating schedule state',()=>{
 const packet=connectionInstructions({url:'https://example.com',principal:{id:'agt_test',name:'Example'},pairing:{id:'pair_fixture',code:'test-only'},ownerId:'hum_test',syncPreference:{mode:'manual'}});
 assert.match(packet,/manual only/);assert.match(packet,/setup pending or manual receiving/);
 assert.ok(!packet.includes('schedule_enabled'));
});
test('app and site use a consistent original icon and explicit demo/state labels',async()=>{
 const [icon,siteIcon,html,site,app]=await Promise.all(['public/icon.svg','website/assets/icon.svg','public/index.html','website/index.html','public/app.js'].map(p=>readFile(new URL('../'+p,import.meta.url),'utf8')));
 assert.equal(icon,siteIcon);assert.match(icon,/viewBox="0 0 64 64"/);
 assert.match(html,/Synthetic example/);assert.match(site,/Synthetic conversation demo/);
 assert.match(html,/Presence is not tracked/);assert.match(app,/Pending acknowledgment/);
 assert.doesNotMatch(app,/receipt-button', '✓'/);
 assert.match(html,/aria-busy="false"/);assert.match(html,/aria-labelledby="modal-title"/);
});
test('full bilingual onboarding packets never override the selected receiving preference',async()=>{
 const {spawnSync}=await import('node:child_process');
 for(const locale of ['en','zh']){
  const code=`globalThis.window={};globalThis.localStorage={getItem:()=>${JSON.stringify(locale)}};
   const {connectionInstructions}=await import('./public/connection-kit.js');
   const preferences=[{mode:'ask'},{mode:'manual'},...[1,5,15,60,90,10080].map(minutes=>({mode:'interval',minutes}))];
   console.log(JSON.stringify(preferences.map(syncPreference=>connectionInstructions({url:'https://example.com',principal:{id:'fixture',name:'Demo'},pairing:{id:'fixture',code:'fixture'},ownerId:'owner',syncPreference}))));`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const packets=JSON.parse(r.stdout);assert.equal(packets.length,8);
  for(const [index,packet] of packets.entries()){
   assert.doesNotMatch(packet,/suggest 30|30 minutes|30 分钟|再继续等待/);
   assert.match(packet,locale==='en'?/minimum interval/:/最短间隔/);
   assert.match(packet,locale==='en'?/real wake/:/真实唤醒/);
   if(index===1)assert.match(packet,locale==='en'?/Do not create a recurring schedule/:/不要创建周期计划/);
  }
 }
});
