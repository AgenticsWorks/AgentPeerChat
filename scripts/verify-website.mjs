// Read-only browser checks for the public introduction site, never the private mailbox.
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=(process.env.AGENTGRAM_SITE_URL||'http://127.0.0.1:8795').replace(/\/$/,'');
function browser(...args){const r=spawnSync('./node_modules/.bin/agent-browser',['--session','agentgram-site-verification',...args],{encoding:'utf8',timeout:45000});if(r.status!==0)throw new Error('Browser '+args[0]+' failed: '+r.stderr);return r.stdout.trim();}
function value(code){return JSON.parse(browser('eval',code));}
const checks=[];
const privateOrigin=new URL(JSON.parse(await readFile('docs/research-conversation.json','utf8')).url).hostname;
try{
 browser('open',base);browser('wait','#demo-contacts .demo-contact');browser('set','viewport','1440','960');
 assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 assert.equal(value('document.querySelector("#demo-title").textContent'),'营销机会讨论');
 assert.ok(value('document.querySelector(".demo-tag").textContent').includes('Mock'));
 const recording=await (await fetch(base+'/research-conversation.json')).json();
 assert.equal(recording.url,undefined);assert.ok(!JSON.stringify(recording).includes(privateOrigin));
 assert.ok(!value('document.documentElement.outerHTML').includes(privateOrigin));
 assert.ok(recording.tools.skillhubCalls>0);assert.ok(recording.messages.at(-1).content.includes('--namespace'));
 checks.push('Mock is labeled; approved real verification remains separate; no private instance address is published');
 assert.equal(value('document.querySelectorAll(".demo-bubble").length'),10);
 assert.ok(value('document.querySelector("#demo-messages").textContent').includes('OpenAI Dots'));
 browser('click','.artifact-link');assert.equal(value('document.querySelector("#artifact-dialog").open'),true);
 assert.ok(value('document.querySelector("#artifact-content").textContent').includes('Mock 输出'));
 browser('click','#artifact-close');assert.equal(value('document.querySelector("#artifact-dialog").open'),false);
 browser('select','#demo-perspective','dots');
 browser('click','[data-thread="launch-preferences"]');
 assert.ok(value('document.querySelector("#demo-title").textContent').includes('Muse'));
 assert.ok(value('document.querySelectorAll(".demo-bubble.mine").length')>0);
 browser('select','#demo-perspective','grok');
 assert.equal(value('document.querySelectorAll("[data-thread=launch-preferences]").length'),0);
 assert.equal(value('document.querySelector("#demo-title").textContent'),'营销机会讨论');
 browser('select','#demo-perspective','muse');assert.equal(value('document.querySelectorAll("[data-thread=launch-sources]").length'),0);
 browser('select','#demo-perspective','all');assert.equal(value('document.querySelectorAll(".demo-contact").length'),3);
 browser('click','[data-scenario=preferences]');
 assert.equal(value('document.querySelector("#demo-title").textContent'),'Dots · Muse');
 assert.ok(value('document.querySelector("#demo-messages").textContent').includes('订单或支付信息'));
 browser('select','#demo-perspective','grok');assert.equal(value('document.querySelectorAll("[data-thread=preferences-dm]").length'),0);
 browser('select','#demo-perspective','dots');browser('click','[data-thread=preferences-group]');
 browser('click','.artifact-link');assert.ok(value('document.querySelector("#artifact-content").textContent').includes('不是某位真实用户'));browser('click','#artifact-close');
 browser('click','#replay');browser('wait','--fn','document.querySelectorAll(".demo-bubble").length === 4');
 checks.push('Both scenarios, three agent perspectives, conversation membership, reciprocal messages, output previews and replay work');
 assert.equal(value('document.querySelector("#pair-approve").disabled'),true);
 browser('select','#pair-agent','dots');browser('click','#pair-copy');
 assert.ok(value('document.querySelector("#pair-output").textContent').includes('DEMO-2048'));
 assert.equal(value('document.querySelector("#pair-approve").disabled'),false);
 browser('click','#pair-approve');assert.ok(value('document.querySelector("#pair-output").textContent').includes('OpenAI Dots 已连接（Mock）'));
 browser('click','#pair-reset');assert.equal(value('document.querySelector("#pair-copy").disabled'),false);
 checks.push('Pairing simulation requires approval, displays a demo code, connects the selected identity and resets without real credentials');
 browser('click','.question-list details:first-child summary');assert.equal(value('document.querySelector(".question-list details").open'),true);
 assert.equal(value('Array.from(document.images).every(image=>image.complete&&image.naturalWidth>0)'),true);

 browser('set','viewport','390','844');assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 browser('select','#demo-perspective','muse');browser('click','[data-scenario=opportunity]');
 assert.equal(value('document.querySelectorAll("[data-thread=launch-sources]").length'),0);
 assert.equal(value('getComputedStyle(document.querySelector("#demo-contacts")).display'),'flex');
 browser('click','[data-thread=launch-preferences]');assert.equal(value('document.querySelector("#demo-title").textContent'),'Dots · Muse');
 assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 checks.push('Mobile perspective switching and direct chats work without horizontal overflow');
 assert.equal(browser('errors'),'');checks.push('No browser errors');
 for(const path of ['/deployment.html','/server-deployment.html','/protocol.html','/product.html','/research.html','/assets/icon.svg','/assets/dots.svg','/assets/grok.svg','/assets/muse.svg','/style.css','/app.js']){
  const response=await fetch(base+path,{signal:AbortSignal.timeout(30000)});assert.equal(response.status,200,path);assert.ok(!(await response.text()).includes(privateOrigin),'Private address in '+path);
 }
 browser('open',base+'/deployment.html');assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 checks.push('Both deployment guides, protocol, product documentation and all referenced static assets load publicly');
 await mkdir('.wrangler',{recursive:true});await writeFile('.wrangler/website-verification.json',JSON.stringify({url:base,verifiedAt:new Date().toISOString(),checks},null,2)+'\n');
 console.log('Introduction website verified: '+base);for(const check of checks)console.log('✓ '+check);
}finally{browser('close');}
