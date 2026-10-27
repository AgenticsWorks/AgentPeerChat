import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
let mf,owner,agent,peer,cookie;const origin='https://browser-events.test',sockets=[];
async function call(path,{key=owner,body,method=body?'POST':'GET',headers={}}={}){return mf.dispatchFetch(origin+'/api/v1'+path,{method,headers:{...(key?{Authorization:'Bearer '+key}:{}),'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID(),...headers},body:body?JSON.stringify(body):undefined});}
before(async()=>{
 const bundle=await build({entryPoints:['src/cloudflare.ts'],bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],write:false});
 mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'browser-events',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-02',d1Databases:{DB:'events'},durableObjects:{NOTIFICATIONS:{className:'MailboxHub',useSQLite:true}},bindings:{SETUP_SECRET:'browser-events-private-fixture'}}]}));
 const db=await mf.getD1Database('DB');for(const f of(await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())await db.exec((await readFile('migrations/'+f,'utf8')).replaceAll('\n',' '));
 owner=(await(await call('/setup',{key:null,body:{name:'Owner',setup_secret:'browser-events-private-fixture'}})).json()).access_key;
 agent=await(await call('/agents',{body:{name:'Grok Bot'}})).json();peer=await(await call('/agents',{body:{name:'Muse'}})).json();
 const response=await call('/session',{key:null,body:{access_key:owner},headers:{Origin:origin}});cookie=response.headers.get('set-cookie').split(';')[0];
});
after(async()=>{for(const socket of sockets)try{socket.close();}catch{}await mf?.dispose();});
function event(socket,type='message'){return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{socket.removeEventListener(type,done);reject(Error('Expected websocket '+type));},5000);function done(value){clearTimeout(timeout);resolve(value);}socket.addEventListener(type,done,{once:true});});}
test('browser streams require an authenticated human session and exact origin',async()=>{
 const headers={Upgrade:'websocket','Sec-WebSocket-Protocol':'apc-v1',Origin:origin};
 assert.equal((await call('/browser/events',{key:null,headers})).status,401);
 assert.equal((await call('/browser/events',{key:agent.token.token,headers})).status,403);
 assert.equal((await call('/browser/events',{key:owner,headers})).status,403);
 assert.equal((await call('/browser/events',{key:null,headers:{...headers,Cookie:cookie,Origin:'https://foreign.test'}})).status,403);
 assert.equal((await call('/browser/events',{key:null,headers:{Cookie:cookie,Origin:origin}})).status,426);
});
test('real browser sockets receive only change signals and do not impersonate native receivers',async()=>{
 const response=await call('/browser/events',{key:null,headers:{Cookie:cookie,Origin:origin,Upgrade:'websocket','Sec-WebSocket-Protocol':'apc-v1'}});assert.equal(response.status,101);const socket=response.webSocket;socket.accept();sockets.push(socket);
 await event(socket);const incoming=event(socket);await call('/messages',{key:agent.token.token,body:{to:[peer.principal.id],type:'text',content:'A private itinerary question.'}});
 const data=JSON.parse((await incoming).data);assert.deepEqual(data,{type:'mailbox_changed'});
 const statuses=(await(await call('/agents/receiving')).json()).items;for(const p of statuses)assert.equal(p.notification.state,'disconnected','browser presence cannot make an Agent look awake');
 const pong=event(socket);socket.send('ping');assert.equal((await pong).data,'pong');
 const closed=event(socket,'close');await call('/session',{key:null,method:'DELETE',headers:{Cookie:cookie,Origin:origin}});
 await call('/messages',{key:agent.token.token,body:{to:[peer.principal.id],type:'text',content:'The next notification rechecks the revoked browser session.'}});assert.equal((await closed).code,4401);
});
test('compact presence reflects native connect and disconnect without exposing mailbox data',async()=>{
 assert.equal((await call('/agents/presence',{key:null})).status,401);assert.equal((await call('/agents/presence',{key:agent.token.token})).status,403);
 const presence=async()=>{const r=await call('/agents/presence');assert.equal(r.status,200);return(await r.json()).items.find(p=>p.id===agent.principal.id);};
 assert.equal((await presence()).notification.state,'disconnected');
 const ticket=(await(await call('/realtime/ticket',{key:agent.token.token,body:{}})).json()).ticket;
 const r=await call('/events',{key:null,headers:{Upgrade:'websocket',Origin:origin,'Sec-WebSocket-Protocol':'apc-v1, ticket.'+ticket}});assert.equal(r.status,101);const socket=r.webSocket;socket.accept();sockets.push(socket);await event(socket);const pong=event(socket);socket.send('ping');await pong;
 const connected=await presence();assert.equal(connected.notification.state,'connected');assert.deepEqual(Object.keys(connected).sort(),['active','id','last_checked_at','notification']);
 const closed=event(socket,'close');socket.close(1000,'Done');await closed;assert.equal((await presence()).notification.state,'disconnected');
});
