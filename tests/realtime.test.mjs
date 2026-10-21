import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {receiveNotifications} from '../scripts/realtime-client.mjs';
let mf,base,db,owner,a,b;
const sockets=[];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+12000;while(!check()){if(Date.now()>end)throw Error('Condition timed out');await pause(20);}}
async function call(path,{key=owner,method='GET',body,idem=crypto.randomUUID()}={}){
 const response=await fetch(base+'/api/v1'+path,{method,headers:{...(key?{Authorization:'Bearer '+key}:{}),'Content-Type':'application/json','Idempotency-Key':idem},body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json()};
}
async function connect(agent){
 const ticket=await call('/realtime/ticket',{key:agent.key,method:'POST'});assert.equal(ticket.status,201);
 const ws=new WebSocket(base.replace('http:','ws:')+'/api/v1/events',['apc-v1','ticket.'+ticket.data.ticket]);sockets.push(ws);
 const events=[];ws.addEventListener('message',e=>{try{events.push(JSON.parse(e.data));}catch{events.push(e.data);}});ws.addEventListener('close',e=>events.push({type:'closed',code:e.code}));
 await until(()=>events.some(e=>e.type==='ready'));return {ws,events,ticket:ticket.data.ticket};
}
before(async()=>{
 const bundled=await build({entryPoints:['src/cloudflare.ts'],bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
 mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'push-test',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-10-02',d1Databases:{DB:'push-db'},durableObjects:{NOTIFICATIONS:{className:'MailboxHub',useSQLite:true}},bindings:{SETUP_SECRET:'private-local-realtime-test-secret'},serviceBindings:{ASSETS:async()=>new Response('assets')}}]}));
 db=await mf.getD1Database('DB');for(const file of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec((await readFile('migrations/'+file,'utf8')).replaceAll('\n',' '));
 base=(await mf.ready).origin;
 owner=(await call('/setup',{key:null,method:'POST',body:{name:'Owner',setup_secret:'private-local-realtime-test-secret'}})).data.access_key;
 for(const name of ['Grok bot','Muse']){const r=(await call('/agents',{method:'POST',body:{name}})).data;const peer={id:r.principal.id,key:r.token.token};if(!a)a=peer;else b=peer;}
});
after(async()=>{for(const s of sockets)s.close();await mf?.dispose();});
test('tickets require an Agent, expire, are single-use and never authorize REST',async()=>{
 assert.equal((await call('/realtime/ticket',{method:'POST'})).status,403);
 assert.equal((await call('/realtime/ticket',{key:null,method:'POST'})).status,401);
 const stream=await connect(a);
 const replay=await mf.dispatchFetch(base+'/api/v1/events',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'apc-v1, ticket.'+stream.ticket}});assert.equal(replay.status,401);
 assert.equal((await call('/me',{key:stream.ticket})).status,401);
 const expired=await call('/realtime/ticket',{key:a.key,method:'POST'});await db.prepare("UPDATE realtime_tickets SET expires_at='2000-01-01T00:00:00.000Z'").run();
 const bad=await mf.dispatchFetch(base+'/api/v1/events',{headers:{Upgrade:'websocket','Sec-WebSocket-Protocol':'apc-v1, ticket.'+expired.data.ticket}});assert.equal(bad.status,401);stream.ws.close();
});
test('committed messages notify only recipients, retain inbox until ACK, and idempotent retries do not notify twice',async()=>{
 const sender=await connect(a),recipient=await connect(b),key=crypto.randomUUID();const body={to:[b.id],type:'text',content:'Compare supplier lead times and report the delivery risk.'};
 const result=await call('/messages',{key:a.key,method:'POST',body,idem:key});assert.equal(result.status,201);
 await until(()=>recipient.events.some(e=>e.type==='mailbox_changed'));assert.ok(!sender.events.some(e=>e.type==='mailbox_changed'));
 const inbox=(await call('/inbox',{key:b.key})).data.items;assert.ok(inbox.some(m=>m.id===result.data.message.id));
 const count=recipient.events.length;assert.equal((await call('/messages',{key:a.key,method:'POST',body,idem:key})).status,200);await pause(100);assert.equal(recipient.events.length,count);
 await call('/messages/'+result.data.message.id+'/ack',{key:b.key,method:'POST',body:{}});assert.ok(!(await call('/inbox',{key:b.key})).data.items.some(m=>m.id===result.data.message.id));
 sender.ws.close();recipient.ws.close();
});
test('new groups notify members; heartbeats work; disabling identity closes the stream',async()=>{
 const stream=await connect(b);stream.ws.send('ping');await until(()=>stream.events.includes('pong'));
 await call('/threads',{key:a.key,method:'POST',body:{title:'Launch research',members:[b.id]}});await until(()=>stream.events.some(e=>e.type==='mailbox_changed'));
 const disabled=await call('/principals/'+b.id,{method:'PATCH',body:{active:false}});assert.equal(disabled.status,200);await until(()=>stream.events.some(e=>e.type==='closed'&&e.code===4401));
 assert.equal((await call('/realtime/ticket',{key:b.key,method:'POST'})).status,401);await call('/principals/'+b.id,{method:'PATCH',body:{active:true}});
 // Disable revokes old keys, so obtain a replacement for subsequent tests.
 b.key=(await call('/tokens',{method:'POST',body:{principal_id:b.id,label:'Replacement'}})).data.token.token;
});
test('conversation receiver status distinguishes live sockets, disconnection and revoked keys without exposing credentials',async()=>{
 const peer=(await call('/agents',{method:'POST',body:{name:'kk-receiver'}})).data;
 const agent={id:peer.principal.id,key:peer.token.token};
 const thread=(await call('/threads',{method:'POST',body:{members:[agent.id],title:'Receiver health'}})).data.thread;
 const path='/threads/'+thread.id+'/receiving';
 assert.equal((await call(path,{key:null})).status,401);
 assert.equal((await call(path,{key:a.key})).status,404,'unrelated Agents cannot observe a private receiver');
 assert.deepEqual((await call(path)).data.items,[{principal_id:agent.id,connected:false}]);
 const stream=await connect(agent);
 const active=await call(path);assert.deepEqual(active.data.items,[{principal_id:agent.id,connected:true}]);
 assert.ok(!JSON.stringify(active.data).includes(agent.key));
 stream.ws.close();
 for(let n=0;n<40&&(await call(path)).data.items[0].connected;n++)await pause(20);
 assert.equal((await call(path)).data.items[0].connected,false);
 const restored=await connect(agent);
 await db.prepare('UPDATE tokens SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),peer.token.id).run();
 assert.equal((await call(path)).data.items[0].connected,false,'an old socket cannot claim receiving after revocation');
 restored.ws.close();
});
test('background receiver has no periodic REST traffic while idle; reconnect discovers messages sent offline',async()=>{
 const ctrl=new AbortController(),states=[];let work=0,requests=0,lastSocket,block,release;
 class ObservedSocket extends WebSocket{constructor(...args){super(...args);lastSocket=this;}}
 const receiver=receiveNotifications({identity:{url:base,token:b.key,principal_id:b.id},signal:ctrl.signal,WebSocketImpl:ObservedSocket,heartbeatMs:100,onState:async s=>states.push(s),wait:async(ms,signal)=>{if(block)await new Promise(r=>release=r);else await pause(10);},request:async(url,options)=>{requests++;const r=await fetch(url,{method:options.method,headers:{Authorization:'Bearer '+options.token}});if(!r.ok)throw Error(r.status+': failed');return r.json();},onWork:async()=>{work++;}});
 try{
  await until(()=>work>=1);const before=requests;await pause(450);assert.equal(requests,before,'heartbeats must not mint tickets or poll REST');
  block=true;lastSocket.close();await until(()=>states.some(s=>s.connected===false));
  const sent=await call('/messages',{key:a.key,method:'POST',body:{to:[b.id],type:'text',content:'Offline supplier update: lead time is 12 days, revise the launch date.'}});assert.equal(sent.status,201);
  const previousWork=work;block=false;release();await until(()=>work>previousWork);
  assert.ok((await call('/inbox',{key:b.key})).data.items.some(m=>m.id===sent.data.message.id));
 }finally{ctrl.abort();release?.();await receiver;}
});
test('notifications received during work are coalesced into a trailing check and busy timer locks are retried',async()=>{
 const ctrl=new AbortController();let ws,started=0,release,done=0,attempts=0;
 class FakeSocket extends EventTarget{constructor(){super();ws=this;queueMicrotask(()=>this.emit('ready'));}emit(type){const event=new Event('message');event.data=JSON.stringify({type});this.dispatchEvent(event);}send(){}close(){this.dispatchEvent(new Event('close'));}}
 const run=receiveNotifications({identity:{url:base,token:'private-test-token'},signal:ctrl.signal,WebSocketImpl:FakeSocket,request:async()=>({ticket:'wst_fixture'}),wait:async()=>pause(5),onWork:async()=>{attempts++;if(attempts===1)return {skipped:true};started++;if(started===1)await new Promise(r=>release=r);done++;}});
 try{await until(()=>started===1);for(let i=0;i<20;i++)ws.emit('mailbox_changed');release();await until(()=>done===2);assert.equal(started,2);assert.equal(attempts,3);}finally{ctrl.abort();release?.();await run;}
});
test('outbound stream supports an HTTP CONNECT proxy without exposing permanent credentials',async()=>{
 const {createServer}=await import('node:http'),{connect:tcp}=await import('node:net');
 const {default:Socket}=await import('../scripts/vendor-websocket.mjs'),{websocketAgent}=await import('../scripts/websocket-transport.mjs');
 const ticket=(await call('/realtime/ticket',{key:b.key,method:'POST'})).data.ticket;let tunnels=0;const open=new Set();
 const proxy=createServer();proxy.on('connect',(req,client,head)=>{tunnels++;assert.equal(req.url,'unreachable.agentpeerchat.invalid:80');assert.ok(!JSON.stringify(req.headers).includes(b.key));const upstream=tcp(Number(new URL(base).port),'127.0.0.1',()=>{client.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);});for(const socket of [client,upstream]){open.add(socket);socket.on('error',()=>{});socket.on('close',()=>open.delete(socket));}});
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const target='ws://unreachable.agentpeerchat.invalid/api/v1/events',agent=websocketAgent(target,{HTTP_PROXY:'http://127.0.0.1:'+proxy.address().port,NO_PROXY:'localhost'});
 const socket=new Socket(target,['apc-v1','ticket.'+ticket],{agent,perMessageDeflate:false});let ready=false;socket.on('message',data=>{if(JSON.parse(data).type==='ready')ready=true;});socket.on('error',()=>{});
 try{await until(()=>ready);assert.equal(tunnels,1);}finally{socket.terminate();agent.destroy();for(const s of open)s.destroy();await new Promise(r=>proxy.close(r));}
});
test('outbound receiving preserves the instance deployment subdirectory',async()=>{
 const ctrl=new AbortController();let endpoint,checks=0;
 class Socket extends EventTarget{constructor(url){super();endpoint=new URL(url);queueMicrotask(()=>{const event=new Event('message');event.data=JSON.stringify({type:'ready'});this.dispatchEvent(event);});}send(){}close(){this.dispatchEvent(new Event('close'));}}
 await receiveNotifications({identity:{url:'https://example.test/team/chat/',token:'fixture'},signal:ctrl.signal,WebSocketImpl:Socket,request:async url=>{assert.equal(url,'https://example.test/team/chat/api/v1/realtime/ticket');return {ticket:'wst_fixture'};},onWork:async()=>{checks++;ctrl.abort();}});
 assert.equal(checks,1);assert.equal(endpoint.href,'wss://example.test/team/chat/api/v1/events');
});

test('owner observes actual notification sockets and heartbeats, excluding revoked connections', async () => {
 const created=(await call('/agents',{method:'POST',body:{name:'Presence fixture'}})).data;
 const peer={id:created.principal.id,key:created.token.token};
 const status=async()=>{const r=await call('/agents/receiving');assert.equal(r.status,200);return r.data.items.find(p=>p.id===peer.id).notification;};
 assert.equal((await status()).state,'disconnected');
 const first=await connect(peer),second=await connect(peer);
 assert.equal((await status()).state,'connecting');
 first.ws.send('ping');await until(()=>first.events.includes('pong'));
 let snapshot=await status();assert.equal(snapshot.state,'connected');assert.equal(snapshot.connections,2);assert.ok(snapshot.last_heartbeat_at);
 assert.doesNotMatch(JSON.stringify(snapshot),/token|principal|ticket/);
 first.ws.close();await until(()=>first.events.some(e=>e.type==='closed'));
 // A still-open socket without a heartbeat is not reported as healthy.
 snapshot=await status();assert.equal(snapshot.connections,1);assert.equal(snapshot.state,'connecting');
 await db.prepare('UPDATE tokens SET revoked_at=? WHERE id=?').bind(new Date().toISOString(),created.token.id).run();
 snapshot=await status();assert.equal(snapshot.state,'disconnected');assert.equal(snapshot.connections,0);
 second.ws.close();
});
