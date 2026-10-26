// Disposable Cloudflare runtime + real browser. No production profile or credentials.
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const exec=promisify(execFile),session='mailbox-'+crypto.randomUUID(),sockets=[];
const browse=async(...args)=>(await exec('./node_modules/.bin/agent-browser',['--session',session,...args],{timeout:30000})).stdout.trim();
const value=async code=>JSON.parse(await browse('eval',code));
const wait=async code=>browse('wait','--fn',code);
let mf;
try {
 const bundle=await build({entryPoints:['src/cloudflare.ts'],bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
 const secret=crypto.randomUUID();
 mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'receiving-browser',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-02',d1Databases:{DB:'receiving-browser'},durableObjects:{NOTIFICATIONS:{className:'MailboxHub',useSQLite:true}},bindings:{SETUP_SECRET:secret},serviceBindings:{ASSETS:async request=>{
   const name=new URL(request.url).pathname.slice(1)||'index.html';
   if(!/^(?:[\w.-]+|avatars\/[\w.-]+)$/.test(name))return new Response('',{status:404});
   try {return new Response(await readFile('public/'+name),{headers:{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html'}});}catch{return new Response('',{status:404});}
 }}}]}));
 const db=await mf.getD1Database('DB');
 for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec((await readFile('migrations/'+file,'utf8')).replaceAll('\n',' '));
 const base=(await mf.ready).origin;let owner;
 const api=async(path,key=owner,method='GET',body)=>{
  const response=await fetch(base+'/api/v1'+path,{method,headers:{...(key?{Authorization:'Bearer '+key}:{}),'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:body===undefined?undefined:JSON.stringify(body)});
  assert.ok(response.ok,'fixture API '+path+' returned '+response.status);return response.json();
 };
 owner=(await api('/setup',null,'POST',{name:'Olivia Chen',setup_secret:secret})).access_key;
 const a=await api('/agents',owner,'POST',{name:'Researcher'});
 const b=await api('/agents',owner,'POST',{name:'Builder'});
 const id=a.principal.id;
 const original=(await api('/messages',owner,'POST',{to:[id],type:'text',content:'Please review the accessibility notes before Friday. Focus on keyboard navigation, contrast, and the mobile message reader.'})).message;
 await api('/messages/'+original.id+'/ack',a.token.token,'POST');
 const group=(await api('/threads',owner,'POST',{title:'Website launch',members:[id,b.principal.id]})).thread;
 for(let i=0;i<34;i++)await api('/messages',owner,'POST',{thread_id:group.id,type:'text',content:i===33?'Review the updated launch plan.\n\nThe content team has finished the first draft. Could you check the remaining milestones and share a concise summary?\n\n发布前请确认移动端体验。':i===32?'<img src=x onerror=alert(1)> This must remain plain text.':`Launch update ${i+1}: content review and next steps.`});
 await api('/messages',owner,'POST',{to:[b.principal.id],type:'json',content:{status:'ready',checks:['keyboard','mobile']}});
 const before=(await db.prepare('SELECT * FROM deliveries ORDER BY recipient_id,message_seq').all()).results;
 await browse('set','viewport','1600','1100');await browse('open',base);
 await value(`fetch('/api/v1/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_key:${JSON.stringify(owner)}})}).then(r=>r.ok)`);
 await browse('reload');await wait('!document.querySelector("#shell").hidden');
 await browse('click','.workspace-nav [data-view="receiving"]');
 await wait('document.querySelectorAll("[data-mailbox-agent]").length===2');
 await browse('click',`[data-mailbox-agent="${id}"]`);
 await wait('document.querySelectorAll(".mailbox-message").length===30');
 await browse('click','.mailbox-message:nth-child(2)');
 assert.equal(await value('document.querySelector(".mailbox-body img")===null'),true);
 assert.match(await value('document.querySelector(".mailbox-body").textContent'),/<img src=x onerror=alert\(1\)>/);
 await browse('click','.mailbox-message');
 assert.equal(await value('document.querySelector(".mailbox-tab-count").textContent'),'34');
 assert.equal(await value('document.documentElement.scrollWidth>innerWidth'),false);
 const out=process.env.AGENTPEERCHAT_SCREENSHOT_DIR;
 if(out){await mkdir(out,{recursive:true});await browse('screenshot',resolve(out,'mailbox-desktop-en.png'));}
 await browse('click','.mailbox-more');await wait('document.querySelectorAll(".mailbox-message").length===34');
 await browse('click','[data-mailbox-status="acked"]');await wait('document.querySelectorAll(".mailbox-message").length===1');
 await browse('click','.mailbox-message');assert.match(await value('document.querySelector(".mailbox-body").textContent'),/accessibility/);
 await browse('click','[data-mailbox-status="all"]');await wait('document.querySelectorAll(".mailbox-message").length===30');
 await browse('fill','.mailbox-toolbar input','accessibility');await wait('document.querySelectorAll(".mailbox-message").length===1');
 await browse('click','.mailbox-message');
 // Failed refresh preserves the readable message and never implies an empty mailbox.
 await value(`window.savedFetch=window.fetch;window.fetch=(url,init)=>String(url).includes('/mailbox?')?Promise.reject(new Error('offline fixture')):window.savedFetch(url,init);true`);
 await browse('click','.mailbox-header button');await wait('!document.querySelector(".mailbox-notice").hidden');
 assert.match(await value('document.querySelector(".mailbox-body").textContent'),/accessibility/);
 await value('window.fetch=window.savedFetch;true');await browse('click','.mailbox-header button');await wait('document.querySelector(".mailbox-notice").hidden');
 await browse('fill','.mailbox-toolbar input','');
 await browse('click','[data-mailbox-status="pending"]');await wait('document.querySelectorAll(".mailbox-message").length===30');
 await browse('select','[data-language-switch]','zh');await browse('click','.mailbox-message');
 assert.equal(await value('document.querySelector(".mailbox-eyebrow").textContent'),'Agent 收件箱');
 await browse('set','viewport','390','844');
 assert.equal(await value('document.documentElement.scrollWidth>innerWidth'),false);
 assert.equal(await value('getComputedStyle(document.querySelector(".mailbox-list-pane")).display'),'none');
 // Bring the reader into the phone viewport, below the shared health summary.
 await browse('eval','document.querySelector(".mailbox-workspace").scrollIntoView();true');
 if(out)await browse('screenshot',resolve(out,'mailbox-mobile-zh.png'));
 await browse('click','.mailbox-reader-back');assert.notEqual(await value('getComputedStyle(document.querySelector(".mailbox-list-pane")).display'),'none');
 await browse('click','.mailbox-back');await browse('click',`[data-mailbox-agent="${b.principal.id}"]`);
 await wait('document.querySelector(".mailbox-identity h2").textContent==="Builder" && document.querySelectorAll(".mailbox-message").length===30');
 // Search the other recipient's JSON delivery, retaining its structured body.
 await browse('fill','.mailbox-toolbar input','ready');await wait('document.querySelectorAll(".mailbox-message").length===1');await browse('click','.mailbox-message');
 assert.match(await value('document.querySelector(".mailbox-body").textContent'),/"status": "ready"/);
 assert.deepEqual((await db.prepare('SELECT * FROM deliveries ORDER BY recipient_id,message_seq').all()).results,before);
 console.log('Mailbox browser checks passed: body safety, filtering, pagination, read-only ACKs, failed refresh, recipient switching, English/Chinese, desktop/mobile.');
} finally {
 for(const ws of sockets)ws.close();
 await browse('close').catch(()=>{});await mf?.dispose();
}
