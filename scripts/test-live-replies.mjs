// Explicit live-model verification. Owner/model credentials arrive only through process environment.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const base = process.env.AGENTPEERCHAT_URL, owner = process.env.AGENTPEERCHAT_OWNER_TOKEN;
if (!base || !owner) throw new Error('Provide the instance URL and owner credentials through the environment.');
const session = 'agentpeerchat-live-replies';
function browser(args, input) {
 const result = spawnSync('./node_modules/.bin/agent-browser', ['--session', session, ...args], {encoding:'utf8',input,timeout:45000});
 if(result.status!==0) throw new Error('Browser step failed: '+args[0]+' '+result.stderr); return result.stdout.trim();
}
const evaluate = code => JSON.parse(browser(['eval','--stdin'],code));
async function api(path, method='GET', body) {
 const response=await fetch(base+'/api/v1'+path,{method,headers:{Authorization:`Bearer ${owner}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 if(!response.ok)throw new Error('Verification request failed: '+path+' '+response.status);return response.json();
}
const me=(await api('/me')).principal;
const bots=[];
let running=true;
const pending=[];
try {
 browser(['open',base]);browser(['wait','#auth-key']);
 evaluate(`document.querySelector('#auth-key').value=${JSON.stringify(owner)};document.querySelector('#auth-submit').click();'submitted'`);
 browser(['wait','#shell:not([hidden])']); browser(['set','viewport','1440','960']);
 for(const [name,description,adapter] of [['小舟','帮你处理问题，也会找伙伴一起讨论。','codex'],['阿岚','一起查证、计算和讨论问题。','claude']]) {
  browser(['click','#menu-toggle']);browser(['click','#main-menu [data-view="network"]']);
  const existing=(await api('/principals')).items.find(p=>p.name===name&&p.kind==='agent'&&p.active);
  if(existing){browser(['wait',`[data-connect-agent="${existing.id}"]`]);browser(['click',`[data-connect-agent="${existing.id}"]`]);}
  else {browser(['click','#create-agent']);browser(['fill','#field-name',name]);browser(['click','#modal-submit']);}
  browser(['wait','#field-secret']);
  const packet=evaluate('document.querySelector("#field-secret").value');
  assert.ok(packet.includes('--from-stdin'));
  assert.ok(packet.includes(' summary'));
  const config=JSON.parse(packet.match(/AGENTPEERCHAT_CONFIG_JSON'\n([\s\S]*?)\nAGENTPEERCHAT_CONFIG_JSON/)[1]);
  assert.equal((await fetch(config.url+'/api/v1/me',{headers:{Authorization:`Bearer ${config.token}`}})).status,200);
  browser(['check','#saved-key']);browser(['click','#modal-submit']);
  // Run the copied installer with the documented CLI runtime option; credentials stay on stdin.
  const command=packet.match(/```sh\n([\s\S]*?)\n```/)[1].replace('--from-stdin', '--from-stdin '+adapter);
  const install=spawnSync('bash',[],{input:command,encoding:'utf8',timeout:90000});
  assert.equal(install.status,0,'Copied installer should connect and save a private profile.');
  const profile=JSON.parse(await readFile(join(homedir(),'.config','agentpeerchat',config.principal_id,'config.json'),'utf8'));
  assert.equal(profile.token,config.token);assert.equal(profile.runtime.adapter,adapter);
  const {createBridge,nativeGenerator}=await import(pathToFileURL(join(homedir(),'.config','agentpeerchat',config.principal_id,'agentpeerchat-runtime.mjs')).href);
  const bridge=createBridge({config,generate:nativeGenerator(adapter,{claude:process.env.AGENTPEERCHAT_CLAUDE_CLI})});
  bots.push({name,adapter,config,bridge});
  pending.push((async()=>{while(running){try{await bridge.tick();}catch(error){console.error(name+': '+error.message);}await new Promise(r=>setTimeout(r,1500));}})());
 }
 browser(['click','#menu-toggle']);browser(['click','#main-menu [data-view="conversations"]']);
 browser(['click','#new-thread']);browser(['click',`[data-contact="${bots[0].config.principal_id}"]`]);browser(['wait','#chat-active:not([hidden])']);
 browser(['wait','--fn','document.querySelector("#chat-title").textContent === "小舟"']);
 assert.equal(evaluate('document.querySelector("#chat-title").textContent'),'小舟');
 const beforeDirect=(await api('/threads?limit=100')).items.find(t=>t.kind==='direct'&&t.participants.some(p=>p.id===bots[0].config.principal_id)&&t.participants.some(p=>p.id===me.id))?.last_message_seq||0;
 browser(['fill','#message-text','请计算 17 × 19，直接告诉我结果。']);browser(['click','#send-button']);
 async function waitForMessages(predicate){const deadline=Date.now()+240000;while(Date.now()<deadline){const threads=(await api('/threads?limit=100')).items;const selected=threads.find(t=>predicate.thread(t));if(selected){const history=await api('/threads/'+selected.id+'?limit=100');if(predicate.messages(history.items))return history;}await new Promise(r=>setTimeout(r,2500));}throw new Error('Automatic model reply did not arrive in time.');}
 const direct=await waitForMessages({thread:t=>t.kind==='direct'&&t.participants.some(p=>p.id===bots[0].config.principal_id)&&t.participants.some(p=>p.id===me.id),messages:items=>items.some(m=>m.seq>beforeDirect&&m.sender_id===bots[0].config.principal_id&&String(m.content).includes('323'))});
 assert.equal(direct.items.filter(m=>m.seq>beforeDirect&&m.sender_id===me.id&&String(m.content).includes('17 × 19')).length,1);
 console.log('Human message from browser → automatic Agent reply: 323 verified.');
 // Refresh via ordinary chat navigation so the browser displays the persisted reply immediately.
 evaluate('Array.from(document.querySelectorAll(".thread-item")).find(b=>b.querySelector("strong").textContent==="小舟").click();"selected"');
 const existingGroup=(await api('/threads?limit=100')).items.find(t=>t.title==='一起聊聊'&&t.participants.some(p=>p.id===bots[0].config.principal_id)&&t.participants.some(p=>p.id===bots[1].config.principal_id));
 if(existingGroup)evaluate('Array.from(document.querySelectorAll(".thread-item")).find(b=>b.querySelector("strong").textContent==="一起聊聊").click();"selected"');
 else {
 browser(['click','#new-thread']);browser(['click','#new-group']);browser(['fill','#field-title','一起聊聊']);
 for(const bot of bots)browser(['check',`input[name="members"][value="${bot.config.principal_id}"]`]);
 browser(['click','#modal-submit']);
 }
 browser(['wait','--fn','!document.querySelector("#modal").open && document.querySelector("#chat-title").textContent === "一起聊聊"']);
 browser(['fill','#message-text','@小舟 请问一下阿岚：23 加 19 等于多少？然后把结论告诉我。']);browser(['click','#send-button']);
 const group=await waitForMessages({thread:t=>t.title==='一起聊聊'&&t.participants.some(p=>p.id===bots[0].config.principal_id),messages:items=>items.some(m=>m.sender_id===bots[1].config.principal_id&&String(m.content).includes('42'))&&items.some((m,index)=>m.sender_id===bots[0].config.principal_id&&String(m.content).includes('42')&&items.slice(0,index).some(p=>p.sender_id===bots[1].config.principal_id))});
 console.log('Browser question → 小舟 asks 阿岚 → 阿岚 answers → 小舟 concludes: 42 verified.');
 const directSend=await fetch(base+'/api/v1/messages',{method:'POST',headers:{Authorization:`Bearer ${bots[0].config.token}`,'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({to:[bots[1].config.principal_id],type:'text',content:'9 乘 8 等于多少？请直接告诉我答案。'})});assert.equal(directSend.status,201);
 const peerMessage=(await directSend.json()).message;
 const peerChat=await waitForMessages({thread:t=>t.id===peerMessage.thread_id,messages:items=>items.some(m=>m.seq>peerMessage.seq&&m.sender_id===bots[1].config.principal_id&&String(m.content).includes('72'))});
 console.log('Agent private message without @mention → automatic peer reply: 72 verified.');

 await new Promise(r=>setTimeout(r,5000));
 const settled=await api('/threads/'+group.thread.id+'?limit=100');assert.ok(settled.items.length<=6,'Agents must stop after finishing the consultation.');
 evaluate('Array.from(document.querySelectorAll(".thread-item")).find(b=>b.querySelector("strong").textContent==="一起聊聊").click();"selected"');
 // UI must contain the real reply, without a page refresh resetting the selected chat.
 browser(['wait','--fn','document.querySelector("#message-list").textContent.includes("42")']);
 assert.equal(evaluate('document.querySelector("#compose-error").textContent'),'');
 assert.equal(browser(['errors']),'');
 await mkdir('docs/screenshots',{recursive:true});browser(['screenshot','docs/screenshots/live-replies-desktop.png']);
 browser(['select','#chat-perspective',bots[0].config.principal_id]);
 assert.ok(evaluate('document.querySelector("#thread-list").textContent').includes('一起聊聊'));
 browser(['set','viewport','390','844']);assert.equal(evaluate('document.documentElement.scrollWidth > innerWidth'),false);browser(['screenshot','docs/screenshots/live-replies-mobile.png']);
 const report={checkedAt:new Date().toISOString(),url:base,identities:bots.map(b=>({name:b.name,adapter:b.adapter,modelProvider:b.adapter==='claude'&&process.env.GLM_CODING_PLAN_API_KEY?'GLM Coding Plan':'existing local account',principalId:b.config.principal_id})),checks:['Copied installation command validated identity and installed private profile','Human sent the question through browser composer; automatic reply was 323','Human asked in a browser-created group; Agents automatically consulted and replied with 42','Plain Agent-to-Agent private question automatically received 72 without @mention','Consultation stopped without endless peer replies','Agent perspective displayed its participating chats','Desktop and mobile rendered actual model replies without browser errors or horizontal overflow'],directThread:direct.thread.id,groupThread:group.thread.id,messages:settled.items.map(m=>({senderId:m.sender_id,content:m.content})),runtimeScope:'Reply listeners ran throughout the verification; model calls were triggered by mailbox messages, not manually per turn.'};
 await writeFile('docs/live-replies-verification.json',JSON.stringify(report,null,2)+'\n');
 console.log('Actual web → mailbox → installed model runtime → web verification passed.');
} finally { running=false;await Promise.allSettled(pending);browser(['close']); }
