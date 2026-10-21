import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {getLanguage, setLanguage, t, localizeDemo} from '../public/i18n.js';
import {connectionInstructions} from '../public/connection-kit.js';

test('English is the initial locale and Chinese can be selected explicitly',()=>{
  assert.equal(getLanguage(),'en');
  assert.equal(t('消息'),'Message');
  setLanguage('zh'); assert.equal(t('Message'),'消息');
  setLanguage('en'); assert.equal(t('{0} 位成员',3),'3 members');
});
test('interpolation leaves names, message text and literal braces untouched',()=>{
  const content='消息 {0}';
  assert.equal(t('{0} 位成员',content),'消息 {0} members');
  assert.equal(localizeDemo({role:'发现机会'}).role,'Find opportunities');
  assert.equal(t('A user’s original message'),'A user’s original message');
});
test('sync states and last successful sync time are available in both languages',()=>{
  for (const [english, chinese] of [
    ['Syncing…', '正在同步…'], ['Sync paused', '同步已暂停'], ['Offline', '离线'],
    ['Sync paused · retrying', '同步暂停 · 正在重试'], ['Last synced {0}', '上次同步 {0}']
  ]) {
    setLanguage('zh'); assert.equal(t(english, '12:34:56'), chinese.replace('{0}', '12:34:56'));
    setLanguage('en'); assert.equal(t(chinese, '12:34:56'), english.replace('{0}', '12:34:56'));
  }
});
test('English connection instructions preserve the exact private configuration JSON',()=>{
  const packet=connectionInstructions({url:'https://example.test',principal:{id:'agt_demo',name:'名字 {0}',nameRequired:false},token:{id:'tok_demo',token:'test-only-{0}'},ownerId:'hum_demo'});
  assert.match(packet,/Join my AgentPeerChat/);
  assert.match(packet,/Automatic receiving is enabled by default/);
  assert.match(packet,/minimum interval/);
  assert.match(packet,/Do not ask for another confirmation/);
  const config=JSON.parse(packet.match(/AGENTPEERCHAT_CONFIG_JSON'\n([\s\S]*?)\nAGENTPEERCHAT_CONFIG_JSON/)[1]);
  assert.equal(config.token,'test-only-{0}');
  assert.equal(config.principal_id,'agt_demo');
  assert.match(packet,/名字 \{0\}/);
});
test('both initial HTML pages are English and expose a language selector',async()=>{
  for(const file of ['public/index.html','website/index.html']){
    const html=await readFile(file,'utf8');
    assert.match(html,/<html lang="en">/);
    assert.match(html,/data-language-switch/);
    assert.doesNotMatch(html.replaceAll('中文',''),/\p{Script=Han}/u,file+' must not initially render Chinese UI');
  }
});
test('the standalone marketing site loads its own translation modules and switches its new copy',async()=>{
  const site=await import('../website/i18n.js');
  site.setLanguage('zh');
  assert.equal(site.t('Messaging.'),'即时通信，');
  assert.equal(site.t('Deploy free on Cloudflare'),'免费部署到我的 Cloudflare');
  assert.equal(site.t('Copy once.'),'复制一次，');
  site.setLanguage('en');
  assert.equal(site.t('即时通信，'),'Messaging.');
});
