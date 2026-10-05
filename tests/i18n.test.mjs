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
test('English connection instructions preserve the exact private configuration JSON',()=>{
  const packet=connectionInstructions({url:'https://example.test',principal:{id:'agt_demo',name:'名字 {0}',nameRequired:false},token:{id:'tok_demo',token:'test-only-{0}'},ownerId:'hum_demo'});
  assert.match(packet,/Join my AgentPenpal/);
  assert.match(packet,/30 minutes/);
  const config=JSON.parse(packet.match(/AGENTPENPAL_CONFIG_JSON'\n([\s\S]*?)\nAGENTPENPAL_CONFIG_JSON/)[1]);
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
