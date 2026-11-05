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
const clickWake=async selector=>{await value('document.querySelector('+JSON.stringify(selector)+').scrollIntoView({block:"center"})');return browse('click',selector);};
let mf, webhookCalls=0, privateWebhookCalls=0;
const webhookAgent='agt_browser_webhook_fixture';
try {
 const bundle=await build({entryPoints:['src/cloudflare.ts'],bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
 const secret=crypto.randomUUID();
 mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'receiving-browser',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-02',d1Databases:{DB:'receiving-browser'},durableObjects:{NOTIFICATIONS:{className:'MailboxHub',useSQLite:true}},bindings:{SETUP_SECRET:secret,AGENTPEERCHAT_WAKE_WEBHOOKS:JSON.stringify({[webhookAgent]:{provider:'grokbot',url:'https://hooks.example.test/routine',token:'private-browser-fixture-key'}})},outboundService:async request=>{
  if(request.url==='https://api2.cursor.sh/automations/webhook/browser-fixture'){assert.equal(request.headers.get('Authorization'),'Bearer private-onboarding-fixture-key');privateWebhookCalls++;}
  else{assert.equal(request.url,'https://hooks.example.test/routine');webhookCalls++;}return new Response();
 },serviceBindings:{ASSETS:async request=>{
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
  let created;
  if(name==='GrokBot'){
   await db.prepare("INSERT INTO principals(id,name,kind) VALUES (?,?,'agent')").bind(webhookAgent,name).run();
   created={principal:{id:webhookAgent},...(await api('/tokens',owner,'POST',{principal_id:webhookAgent,label:'Fixture'}))};
  }else created=await api('/agents',owner,'POST',{name});
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
 await browse('click','.workspace-nav [data-view="access"]');await browse('click','#access [data-view="receiving"]');
 await wait('document.querySelectorAll("#receiving tbody tr").length===5');
 assert.deepEqual(await value('[...document.querySelectorAll(".receiving-stat strong")].map(n=>n.textContent)'),['4','2','1','0']);
 await browse('select','[data-language-switch]','zh');
 await browse('click',`[data-receiving-agent="${agents[3].id}"]`);
 assert.equal(await value('document.querySelector(".receiving-detail h2").textContent'),'GrokBot');
 assert.match(await value('document.querySelector(".receiving-detail").textContent'),/未上报/);
 await wait('document.querySelector(".receiving-detail").textContent.includes("触发请求已接受")');
 assert.equal(webhookCalls,1);
 assert.match(await value('document.querySelector(".receiving-detail").textContent'),/回复和 ACK 才能确认/);
 await browse('click','[data-receiving-action="wake"]');
 await wait('document.querySelector(".receiving-detail").textContent.includes("唤醒已排队")');
 assert.equal(await value('document.querySelector("[data-receiving-action=wake]").disabled'),true);
 await value('new Promise(resolve=>setTimeout(resolve,1300))');await browse('click','.receiving-actions button');
 await wait('document.querySelector("[data-receiving-action=wake]")?.disabled===false');
 assert.equal(webhookCalls,2);
 assert.deepEqual(await value('[...document.querySelectorAll(".receiving-stat strong")].map(n=>n.textContent)'),['4','2','1','0']);
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
 await browse('select','[data-language-switch]','en');await browse('click','.workspace-nav [data-view="access"]');await browse('click','#access [data-view="receiving"]');
 await wait('document.querySelectorAll("#receiving tbody tr").length===5');
 assert.equal(await value('document.querySelector("#receiving h1").textContent'),'Agent receiving status');
 console.log('Existing receiving flow passed; testing private setup.');
 // Complete private setup through a real owner deep link; no secret is copied into chat.
 const hostedCreated=await api('/agents',owner,'POST',{name:'Grok Bot (webhook)'});
 const hosted={id:hostedCreated.principal.id,key:hostedCreated.token.token},setupURL=base+'/#wake-agent='+hosted.id;
 await browse('open',setupURL);
 await wait('!document.querySelector(".wake-setup").hidden && !document.querySelector(".wake-form button[type=submit]").disabled');
 assert.equal(await value('document.querySelector(".wake-header h2").textContent'),'Grok Bot (webhook)');
 assert.equal(await value('location.hash'),'');
 assert.equal(await value('document.querySelector("#wake-token").type'),'password');
 await browse('fill','#wake-url','https://api2.cursor.sh/automations/webhook/browser-fixture');
 await browse('fill','#wake-token','private-onboarding-fixture-key');
 await value('document.querySelector("#wake-token").focus();window.savedWakeInput=document.querySelector("#wake-token");true');
 await clickWake('.wake-header button');
 await value('document.querySelector("#wake-token").focus();true');
 await value('new Promise(resolve=>setTimeout(resolve,5500))');
 assert.equal(await value('document.querySelector("#wake-token")===window.savedWakeInput && document.activeElement===window.savedWakeInput && window.savedWakeInput.value==="private-onboarding-fixture-key"'),true);
 await clickWake('.wake-form button[type=submit]');
 await wait('!document.querySelector(".wake-saved").hidden');
 assert.equal(privateWebhookCalls,0,'saving credentials must not start a model turn');console.log('Private form saved without a model wake.');
 assert.equal(await value('document.querySelector("#wake-token").value'),'');
 assert.equal(await value('document.querySelector("#wake-url").value'),'');
 assert.equal(await value('document.querySelector(".wake-setup").textContent.includes("private-onboarding-fixture-key")'),false);
 assert.equal(await value('JSON.stringify(localStorage).includes("private-onboarding-fixture-key") || JSON.stringify(sessionStorage).includes("private-onboarding-fixture-key")'),false);
 const configured=await api('/agents/'+hosted.id+'/wake/config');
 assert.equal(configured.configured,true);assert.equal(configured.verification,null);
 assert.ok(!JSON.stringify(configured).includes('browser-fixture'));
 // Lose the test response once, then retry with exactly the same idempotency key.
 await value(`window.savedWakeFetch=window.fetch;window.wakeTestKeys=[];window.dropWakeResponse=true;window.fetch=async(url,options)=>{if(String(url).endsWith('/wake/test')){window.wakeTestKeys.push(options.headers['Idempotency-Key']);const response=await window.savedWakeFetch(url,options);if(window.dropWakeResponse){window.dropWakeResponse=false;throw Error('simulated response loss');}return response;}return window.savedWakeFetch(url,options);};true`);
 await clickWake('.wake-card:last-child .primary');
 await wait('!document.querySelector(".wake-error").hidden');
 await clickWake('.wake-card:last-child .primary');
 await wait('!document.querySelector(".wake-feedback").hidden');
 assert.equal(await value('window.wakeTestKeys.length===2 && window.wakeTestKeys[0]===window.wakeTestKeys[1]'),true);
 await value('window.fetch=window.savedWakeFetch;true');
 let verification=(await api('/agents/'+hosted.id+'/wake/config')).verification;
 assert.equal(verification.state,'waiting');
 await value('new Promise(resolve=>setTimeout(resolve,1300))');assert.equal(privateWebhookCalls,1);
 await clickWake('.wake-header button');
 await wait('document.querySelector(".wake-observations").textContent.includes("Trigger accepted")');
 assert.doesNotMatch(await value('document.querySelector(".wake-observations").textContent'),/Reply and ACK verified/);
 await api('/messages',hosted.key,'POST',{thread_id:verification.thread_id,type:'text',content:'wrong answer',reply_to:verification.message_id});
 await api('/messages/'+verification.message_id+'/ack',hosted.key,'POST');
 await clickWake('.wake-header button');
 await wait('document.querySelector(".wake-observations").textContent.includes("ACK received · awaiting reply")');
 await api('/messages',hosted.key,'POST',{thread_id:verification.thread_id,type:'text',content:'714',reply_to:verification.message_id});
 await clickWake('.wake-header button');
 await wait('document.querySelector(".wake-observations").textContent.includes("Reply and ACK verified")');
 assert.equal((await api('/agents/'+hosted.id+'/wake/config')).verification.state,'verified');console.log('Real test reply and ACK verified.');
 await browse('select','[data-language-switch]','zh');
 assert.match(await value('document.querySelector(".wake-observations").textContent'),/回复与 ACK 已验证/);
 assert.equal(await value('document.querySelector(".receiving-error").hidden'),true);
 if(process.env.AGENTPEERCHAT_SCREENSHOT_DIR){await browse('set','viewport','1600','1600');await value('document.querySelector("#receiving").scrollTop=0');await browse('screenshot',resolve(process.env.AGENTPEERCHAT_SCREENSHOT_DIR,'wake-setup-desktop-zh.png'));}
 await browse('set','viewport','390','844');assert.equal(await value('document.documentElement.scrollWidth>innerWidth'),false);
 if(process.env.AGENTPEERCHAT_SCREENSHOT_DIR){await browse('set','viewport','390','1900');await value('document.querySelector("#receiving").scrollTop=0');await browse('screenshot',resolve(process.env.AGENTPEERCHAT_SCREENSHOT_DIR,'wake-setup-mobile-zh.png'));await browse('set','viewport','390','844');}
 // Configuration replacement is private, editable and cleared on navigation.
 await clickWake('.wake-saved .wake-actions button:first-child');
 await browse('fill','#wake-token','discard-on-navigation-fixture');
 await clickWake('.wake-setup>.mailbox-back');
 assert.equal(await value('document.querySelector("#wake-token")===null'),true);
 await api('/principals/'+hosted.id,owner,'PATCH',{active:false});
 await browse('set','viewport','1600','1000');await browse('open',base+'/?fixture=disabled#wake-agent='+hosted.id);
 await wait('!document.querySelector(".wake-saved").hidden');
 assert.equal(await value('document.querySelector(".wake-saved .wake-actions button:first-child").disabled'),true);
 assert.equal(await value('document.querySelector(".wake-saved .wake-actions button:last-child").disabled'),false);
 await browse('select','[data-language-switch]','en');
 await clickWake('.wake-saved .wake-actions button:last-child');
 await clickWake('.wake-remove-confirm .wake-actions button:first-child');
 await wait('document.querySelector(".wake-feedback").textContent.includes("Webhook disconnected")');
 assert.equal((await api('/agents/'+hosted.id+'/wake/config')).configured,false);
 assert.equal((await api('/agents/'+hosted.id+'/wake/config')).verification,null);
 await api('/principals/'+hosted.id,owner,'PATCH',{active:true});await browse('open',setupURL);
 await wait('!document.querySelector(".wake-form").hidden && !document.querySelector(".wake-form button[type=submit]").disabled');
 // Errors do not reflect secret-bearing provider text, and auth loss clears inputs.
 await value(`window.savedWakeFetch=window.fetch;window.fetch=(url,options)=>String(url).endsWith('/wake/config')&&options?.method==='PUT'?Promise.resolve(Response.json({error:{message:'private-error-fixture-key'}},{status:400})):window.savedWakeFetch(url,options);true`);
 await browse('fill','#wake-url','https://api2.cursor.sh/automations/webhook/browser-fixture');
 await browse('fill','#wake-token','private-error-fixture-key');await clickWake('.wake-form button[type=submit]');
 await wait('!document.querySelector(".wake-error").hidden');
 assert.equal(await value('document.querySelector(".wake-setup").textContent.includes("private-error-fixture-key")'),false);
 assert.equal(await value('document.querySelector("#wake-token").value'),'');
 await value('window.fetch=window.savedWakeFetch;true');
 await browse('fill','#wake-token','clear-on-auth-loss-fixture');
 await value(`window.fetch=(url,options)=>String(url).endsWith('/wake/config')&&(!options?.method||options.method==='GET')?Promise.resolve(Response.json({error:{message:'Session ended'}},{status:401})):window.savedWakeFetch(url,options);true`);
 await clickWake('.wake-header button');await wait('!document.querySelector("#onboarding").hidden');
 assert.equal(await value('document.querySelector("#wake-token")===null'),true);
 await value('window.fetch=window.savedWakeFetch;true');
 // A plain setup link survives manual sign-in without granting owner privileges.
 await value('fetch("/api/v1/session",{method:"DELETE"}).then(r=>r.ok)');
 await browse('open',setupURL);await wait('!document.querySelector("#onboarding").hidden');
 await browse('click','#recovery-toggle');await browse('fill','#auth-key',owner);await browse('click','#auth-submit');
 await wait('!document.querySelector(".wake-setup").hidden');
 assert.equal(await value('document.querySelector(".wake-header h2").textContent'),'Grok Bot (webhook)');
 // Non-owner human session: Agents cannot establish browser sessions.
 const invite=(await api('/invites',owner,'POST',{})).invite;
 const human=(await api('/invites/redeem',null,'POST',{code:invite.code,name:'Teammate'})).access_key;
 await value(`fetch('/api/v1/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_key:${JSON.stringify(human)}})}).then(r=>r.ok)`);
 await browse('open',base+'/?fixture=human#wake-agent='+hosted.id);await wait('!document.querySelector("#shell").hidden');
 assert.equal(await value('document.querySelector("#wake-token")===null'),true);
 assert.equal(await value('[...document.querySelectorAll("[data-view=receiving]")].every(n=>n.hidden)'),true);
 assert.equal(await value('fetch("/api/v1/agents/receiving").then(r=>r.status)'),403);
 console.log('Receiving UI verified: live sockets + heartbeats, backlog, ACK, bilingual desktop/mobile, filters, detail navigation, failure recovery, private credential lifecycle, idempotent test retry, real reply + ACK verification and owner-only access.');
} catch(error) {
 try{console.error(await value('({url:location.href,scrollY,rootY:document.querySelector("#receiving").getBoundingClientRect().y,rootScroll:document.querySelector("#receiving").scrollTop,headerY:document.querySelector(".wake-header")?.getBoundingClientRect().y})'));await browse('screenshot','/tmp/agentpeerchat-private-ui-failure.png');}catch{}
 throw error;
} finally {
 try{await browse('close');}catch{}
 for(const socket of sockets)socket.close();await mf?.dispose();
}
