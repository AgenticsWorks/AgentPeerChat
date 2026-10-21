import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {syncInstructions,connectionInstructions} from '../public/connection-kit.js';
test('sync instructions default to automatic receiving and preserve manual/custom choices',()=>{
 for(const minutes of [1,5,15,60,90,1440])assert.ok(syncInstructions({mode:'interval',minutes}).includes(`${minutes}-minute fallback`));
 assert.match(syncInstructions({mode:'manual'}),/Do not create a recurring schedule/);
 assert.match(syncInstructions(),/Automatic receiving is enabled by default/);
 for(const minutes of [0,-1,1.5,1441,NaN,Infinity,'bad'])assert.throws(()=>syncInstructions({mode:'interval',minutes}));
 assert.throws(()=>syncInstructions({mode:'online'}));
});
test('app and site use a consistent original icon and explicit demo/state labels',async()=>{
 const [icon,siteIcon,html,site,app]=await Promise.all(['public/icon.svg','website/assets/icon.svg','public/index.html','website/index.html','public/app.js'].map(p=>readFile(new URL('../'+p,import.meta.url),'utf8')));
 assert.equal(icon,siteIcon);assert.match(icon,/viewBox="0 0 64 64"/);
 assert.match(html,/Synthetic example/);assert.match(site,/Example conversation/);
 assert.match(html,/A connection does not guarantee processing/);assert.match(app,/Pending acknowledgment/);
 assert.doesNotMatch(app,/receipt-button', '✓'/);
 assert.match(html,/aria-busy="false"/);assert.match(html,/aria-labelledby="modal-title"/);
});
test('bilingual packets carry the same receiving choice in executable JSON',async()=>{
 const {setLanguage}=await import('../public/i18n.js');
 for(const locale of ['en','zh']){
  setLanguage(locale);
  for(const preference of [{mode:'auto'},{mode:'manual'},{mode:'interval',minutes:90}]){
   const packet=connectionInstructions({url:'https://example.test',principal:{id:'agt_fixture',name:'Muse'},pairing:{id:'fixture',code:'fixture'},ownerId:'owner',syncPreference:preference});
   const config=JSON.parse(packet.match(/AGENTPEERCHAT_CONFIG_JSON'\n([\s\S]*?)\nAGENTPEERCHAT_CONFIG_JSON/)[1]);
   assert.deepEqual(config.receiving,preference);
   if(preference.mode==='manual')assert.doesNotMatch(packet,/enables realtime receiving|自动开启实时收信/);
   if(preference.mode==='interval')assert.match(packet,/90/);
   assert.match(packet,locale==='en'?/Join my AgentPeerChat/:/接入我的 AgentPeerChat/);
  }
 }
 setLanguage('en');
});
