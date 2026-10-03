// Read-only browser checks for the public introduction site, never the private mailbox.
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const base=(process.env.AGENTGRAM_SITE_URL||'http://127.0.0.1:8795').replace(/\/$/,'');
function browser(...args){const r=spawnSync('./node_modules/.bin/agent-browser',['--session','agentgram-site-verification',...args],{encoding:'utf8',timeout:45000});if(r.status!==0)throw new Error('Browser '+args[0]+' failed: '+r.stderr);return r.stdout.trim();}
function value(code){return JSON.parse(browser('eval',code));}
const checks=[];
try{
 browser('open',base);browser('wait','#demo-contacts .demo-contact');browser('set','viewport','1440','960');
 assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 assert.equal(value('document.querySelector("#demo-title").textContent'),'搜索技能选型');
 assert.ok(value('document.querySelector(".demo-tag").textContent').includes('真实任务'));
 const recording=await (await fetch(base+'/research-conversation.json')).json();
 assert.ok(recording.tools.skillhubCalls>0);assert.ok(recording.messages.some(m=>m.name==='阿岚'));assert.ok(recording.messages.at(-1).content.includes('--namespace'));
 browser('select','#perspective','mist');assert.ok(value('document.querySelector("#demo-members").textContent').includes('阿岚参与'));
 assert.equal(value('document.querySelectorAll(".demo-bubble").length'),recording.preview_indexes.length);
 browser('click','.expand-message');assert.equal(value('document.querySelector(".expand-message").getAttribute("aria-expanded")'),'true');
 browser('click','#replay');browser('wait','--fn',`document.querySelectorAll(".demo-bubble").length === ${recording.preview_indexes.length}`);
 browser('click','.question-list details:first-child summary');assert.equal(value('document.querySelector(".question-list details").open'),true);
 assert.equal(value('Array.from(document.images).every(image=>image.complete&&image.naturalWidth>0)'),true);
 checks.push('Actual SkillHub findings, peer review, corrected CLI instructions, perspective selection and complete-message expansion verified');
 browser('set','viewport','390','844');browser('select','#perspective','boat');assert.ok(value('document.querySelector("#demo-members").textContent').includes('小舟参与'));assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 checks.push('Mobile perspective selector works without horizontal overflow');
 assert.equal(browser('errors'),'');checks.push('No browser errors');
 for(const path of ['/deployment.html','/server-deployment.html','/protocol.html','/product.html','/research.html','/assets/icon.svg','/assets/dots.svg','/assets/grok.svg','/assets/muse.svg','/style.css','/app.js']){
  const response=await fetch(base+path,{signal:AbortSignal.timeout(30000)});assert.equal(response.status,200,path);
 }
 browser('open',base+'/deployment.html');assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 checks.push('Both deployment guides, protocol, product documentation and all referenced static assets load publicly');
 await mkdir('.wrangler',{recursive:true});await writeFile('.wrangler/website-verification.json',JSON.stringify({url:base,verifiedAt:new Date().toISOString(),checks},null,2)+'\n');
 console.log('Introduction website verified: '+base);for(const check of checks)console.log('✓ '+check);
}finally{browser('close');}
