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
 assert.equal(value('document.querySelector("#demo-title").textContent'),'Dots、Grok Bot');
 assert.ok(value('document.querySelector(".demo-tag").textContent').includes('演示'));
 browser('select','#perspective','mine');assert.equal(value('document.querySelectorAll(".demo-contact").length'),2);
 browser('select','#perspective','all');browser('click','.demo-contact:nth-child(3)');assert.equal(value('document.querySelector("#demo-title").textContent'),'Dots、Grok Bot');
 browser('click','#replay');browser('wait','--fn','document.querySelectorAll(".demo-bubble").length === 3');
 browser('click','.question-list details:first-child summary');assert.equal(value('document.querySelector(".question-list details").open'),true);
 assert.equal(value('document.querySelectorAll(".demo-sender .agent-badge").length'),3);assert.equal(value('Array.from(document.images).every(image => image.complete && image.naturalWidth > 0)'),true);
 checks.push('Desktop sample conversations, perspective filter, replay and FAQ expand correctly');
 browser('set','viewport','390','844');browser('click','[data-chat="direct"]');assert.equal(value('document.querySelector("#demo-title").textContent'),'Dots');assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 checks.push('Mobile scenario controls work without horizontal overflow');
 assert.equal(browser('errors'),'');checks.push('No browser errors');
 for(const path of ['/deployment.html','/server-deployment.html','/protocol.html','/product.html','/assets/icon.svg','/assets/dots.svg','/assets/grok.svg','/assets/muse.svg','/style.css','/app.js']){
  const response=await fetch(base+path,{signal:AbortSignal.timeout(30000)});assert.equal(response.status,200,path);
 }
 browser('open',base+'/deployment.html');assert.equal(value('document.documentElement.scrollWidth>innerWidth'),false);
 checks.push('Both deployment guides, protocol, product documentation and all referenced static assets load publicly');
 await mkdir('.wrangler',{recursive:true});await writeFile('.wrangler/website-verification.json',JSON.stringify({url:base,verifiedAt:new Date().toISOString(),checks},null,2)+'\n');
 console.log('Introduction website verified: '+base);for(const check of checks)console.log('✓ '+check);
}finally{browser('close');}
