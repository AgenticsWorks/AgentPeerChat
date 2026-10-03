// Verify communication scenes and installation controls without accessing a private inbox.
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=(process.env.AGENTGRAM_SITE_URL||'http://127.0.0.1:8795').replace(/\/$/,'');
function browser(...args){const r=spawnSync('./node_modules/.bin/agent-browser',['--session','agentgram-site-verification',...args],{encoding:'utf8',timeout:45000});if(r.status!==0)throw new Error('Browser '+args[0]+' failed: '+r.stderr);return r.stdout.trim();}
function value(code){return JSON.parse(browser('eval',code));}
const checks=[],privateOrigin=new URL(JSON.parse(await readFile('docs/research-conversation.json','utf8')).url).hostname;
try{
 browser('open',base);browser('wait','#demo-contacts .demo-contact');browser('set','viewport','1440','960');
 assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 assert.equal(value('document.querySelector("#demo-title").textContent'),'营销机会讨论');
 assert.equal(value('document.querySelector(".demo-tag").textContent'),'通信场景动画');
 const page=value('document.documentElement.outerHTML');assert.ok(!page.includes(privateOrigin));assert.ok(!/Mock|测试工具|通信验证记录/.test(value('document.body.innerText')));
 assert.equal(value('document.querySelectorAll("#pair-agent, #pair-copy, #pair-approve").length'),0);
 assert.equal(value('document.querySelectorAll("a[href*=research]").length'),0);
 checks.push('Agent-first scene; no pairing game, test-record entry or private instance link');
 assert.equal(value('document.querySelectorAll(".demo-bubble").length'),10);
 browser('click','.artifact-link');assert.equal(value('document.querySelector("#artifact-dialog").open'),true);browser('click','#artifact-close');
 browser('select','#demo-perspective','dots');browser('click','[data-thread=launch-preferences]');assert.ok(value('document.querySelectorAll(".demo-bubble.mine").length')>0);
 browser('select','#demo-perspective','grok');assert.equal(value('document.querySelectorAll("[data-thread=launch-preferences]").length'),0);
 browser('select','#demo-perspective','all');browser('click','[data-scenario=preferences]');assert.equal(value('document.querySelector("#demo-title").textContent'),'Dots · Muse');
 browser('select','#demo-perspective','grok');assert.equal(value('document.querySelectorAll("[data-thread=preferences-dm]").length'),0);
 browser('select','#demo-perspective','dots');browser('click','[data-thread=preferences-group]');browser('click','.artifact-link');assert.ok(value('document.querySelector("#artifact-content").textContent').includes('趋势分析'));browser('click','#artifact-close');
 browser('click','#replay');browser('wait','--fn','document.querySelectorAll(".demo-bubble").length === 4');
 checks.push('Reciprocal messages, three perspectives, direct/group visibility and output previews work');
 browser('eval','document.documentElement.style.scrollBehavior="auto";document.querySelector("#network").scrollIntoView({behavior:"instant",block:"center"})');
 const previous=value('document.querySelector("#network-status").textContent');browser('click','#network-next');assert.notEqual(value('document.querySelector("#network-status").textContent'),previous);assert.ok(value('document.querySelectorAll("[data-edge].active").length')>0);assert.ok(value('document.querySelector("#network-message").textContent').includes('→'));
 browser('click','[data-network-agent=muse]');assert.equal(value('document.querySelector("#demo-perspective").value'),'muse');
 checks.push('Network animates actual scene delivery directions, counts traffic, and links nodes to agent perspectives');
 assert.ok(value('document.querySelector("#cloudflare-deploy").href').startsWith('https://deploy.workers.cloudflare.com/?url='));
 browser('eval','document.querySelector("#copy-connect").scrollIntoView({behavior:"instant",block:"center"})');browser('wait','500');browser('click','#copy-connect');assert.ok(value('document.querySelector("#connect-instruction").textContent').includes('agentgram skill --install'));
 browser('wait','--fn','document.querySelector("#connect-copy-status").textContent.length > 0');
 browser('eval','document.querySelector("#copy-deploy").scrollIntoView({behavior:"instant",block:"center"})');browser('wait','500');browser('click','#copy-deploy');assert.ok(value('document.querySelector("#deploy-instruction").textContent').includes('npm run deploy:cli'));
 browser('wait','--fn','document.querySelector("#deploy-copy-status").textContent.length > 0');
 checks.push('One CLI + skill instruction, direct Cloudflare installer link and copy-to-agent deployment request work');
 browser('click','.question-list details:first-child summary');assert.equal(value('document.querySelector(".question-list details").open'),true);
 assert.equal(value('Array.from(document.images).every(image=>image.complete&&image.naturalWidth>0)'),true);
 browser('set','viewport','390','844');assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 browser('select','#demo-perspective','muse');browser('click','[data-scenario=opportunity]');assert.equal(value('document.querySelectorAll("[data-thread=launch-sources]").length'),0);
 browser('click','[data-thread=launch-preferences]');assert.equal(value('document.querySelector("#demo-title").textContent'),'Dots · Muse');
 assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 assert.equal(browser('errors'),'');checks.push('Mobile interactions, images and layout verified; no browser errors');
 for(const path of ['/product.html','/assets/icon.svg','/assets/dots.svg','/assets/grok.svg','/assets/muse.svg','/style.css','/app.js']){const response=await fetch(base+path,{signal:AbortSignal.timeout(30000)});assert.equal(response.status,200,path);assert.ok(!(await response.text()).includes(privateOrigin),path);}
 await mkdir('.wrangler',{recursive:true});await writeFile('.wrangler/website-verification.json',JSON.stringify({url:base,verifiedAt:new Date().toISOString(),checks},null,2)+'\n');console.log('Introduction website verified: '+base);for(const check of checks)console.log('✓ '+check);
}finally{browser('close');}
