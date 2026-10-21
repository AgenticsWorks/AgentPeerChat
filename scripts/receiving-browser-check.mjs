// Disposable Cloudflare runtime + real browser. No production profile or credentials.
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFile,readdir,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const exec=promisify(execFile),session='receiving-'+crypto.randomUUID(),sockets=[];
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
 owner=(await api('/setup',null,'POST',{name:'Owner',setup_secret:secret})).access_key;
 const agents=[];
 for(const name of ['Codex-Mac','WorkBuddy','Muse','GrokBot','Test Agent']){
  const created=await api('/agents',owner,'POST',{name});
  const a={id:created.principal.id,key:created.token.token};agents.push(a);
  if(name==='Test Agent'){await api('/principals/'+a.id,owner,'PATCH',{active:false});continue;}
  const msg=(await api('/messages',owner,'POST',{to:[a.id],type:'text',content:'Local receiving verification'})).message;
  if(name!=='GrokBot'){
   await api('/probe',a.key);await api('/messages',a.key,'POST',{thread_id:msg.thread_id,type:'text',content:'Verified local reply',reply_to:msg.id});await api('/messages/'+msg.id+'/ack',a.key,'POST');
  }
 }
 for(const a of agents.slice(0,2)){
  const {ticket}=await api('/realtime/ticket',a.key,'POST');
  const ws=new WebSocket(base.replace('http:','ws:')+'/api/v1/events',['apc-v1','ticket.'+ticket]);sockets.push(ws);
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('WebSocket heartbeat timed out')),10000);ws.addEventListener('message',e=>{if(e.data==='pong'){clearTimeout(timeout);resolve();}else if(JSON.parse(e.data).type==='ready')ws.send('ping');});ws.addEventListener('error',reject);});
 }
 await browse('set','viewport','1600','1000');await browse('open',base);
 await value(`fetch('/api/v1/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_key:${JSON.stringify(owner)}})}).then(r=>r.ok)`);
 await browse('reload');await wait('!document.querySelector("#shell").hidden');
 await browse('click','.workspace-nav [data-view="receiving"]');
 await wait('document.querySelectorAll("#receiving tbody tr").length===5');
 assert.deepEqual(await value('[...document.querySelectorAll(".receiving-stat strong")].map(n=>n.textContent)'),['4','2','1','0']);
 await browse('select','[data-language-switch]','zh');
 await browse('click',`[data-receiving-agent="${agents[3].id}"]`);
 assert.equal(await value('document.querySelector(".receiving-detail h2").textContent'),'GrokBot');
 assert.match(await value('document.querySelector(".receiving-detail").textContent'),/未上报/);
 assert.equal(await value('document.documentElement.scrollWidth>innerWidth'),false);
 if(process.env.AGENTPEERCHAT_SCREENSHOT_DIR){await mkdir(process.env.AGENTPEERCHAT_SCREENSHOT_DIR,{recursive:true});await browse('screenshot',resolve(process.env.AGENTPEERCHAT_SCREENSHOT_DIR,'receiving-desktop-zh.png'));}
 await browse('click','[data-receiving-filter="attention"]');assert.equal(await value('document.querySelectorAll("#receiving tbody tr").length'),1);
 await browse('click','[data-receiving-filter="disabled"]');assert.equal(await value('document.querySelectorAll("#receiving tbody tr").length'),1);
 await browse('click','[data-receiving-filter="all"]');await browse('fill','.receiving-toolbar input','Muse');assert.equal(await value('document.querySelectorAll("#receiving tbody tr").length'),1);
 await browse('fill','.receiving-toolbar input','');
 await browse('set','viewport','390','844');assert.equal(await value('document.documentElement.scrollWidth>innerWidth'),false);
 if(process.env.AGENTPEERCHAT_SCREENSHOT_DIR)await browse('screenshot',resolve(process.env.AGENTPEERCHAT_SCREENSHOT_DIR,'receiving-mobile-zh.png'));
 await browse('set','viewport','1600','1000');
 // A failed refresh must not leave green connectivity badges from an old snapshot.
 await value(`window.originalFetch=window.fetch;window.fetch=(url,options)=>String(url).includes('/agents/receiving')?Promise.reject(new Error('simulated outage')):window.originalFetch(url,options);true`);
 await browse('click','.receiving-actions button');await wait('!document.querySelector(".receiving-error").hidden');
 assert.equal(await value('document.querySelectorAll(".receiving-transport.connected").length'),0);
 await value('window.fetch=window.originalFetch;true');await browse('click','.receiving-actions button');
 await wait('document.querySelectorAll(".receiving-transport.connected").length===2');
 await browse('click','[data-receiving-action="open"]');await wait('!document.querySelector("#chat-active").hidden');
 assert.equal(await value('document.querySelector("#receiving").hidden'),true);
 await browse('select','[data-language-switch]','en');await browse('click','.workspace-nav [data-view="receiving"]');
 await wait('document.querySelectorAll("#receiving tbody tr").length===5');
 assert.equal(await value('document.querySelector("#receiving h1").textContent'),'Agent receiving status');
 // Non-owner human session: Agents cannot establish browser sessions.
 const invite=(await api('/invites',owner,'POST',{})).invite;
 const human=(await api('/invites/redeem',null,'POST',{code:invite.code,name:'Teammate'})).access_key;
 await value(`fetch('/api/v1/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_key:${JSON.stringify(human)}})}).then(r=>r.ok)`);
 await browse('reload');await wait('!document.querySelector("#shell").hidden');
 assert.equal(await value('[...document.querySelectorAll("[data-view=receiving]")].every(n=>n.hidden)'),true);
 assert.equal(await value('fetch("/api/v1/agents/receiving").then(r=>r.status)'),403);
 console.log('Receiving UI verified: live sockets + heartbeats, backlog, ACK, bilingual desktop/mobile, filters, detail navigation, failure recovery and owner-only access.');
} finally {
 try{await browse('close');}catch{}
 for(const socket of sockets)socket.close();await mf?.dispose();
}
