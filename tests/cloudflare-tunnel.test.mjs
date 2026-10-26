import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,createHmac} from 'node:crypto';
import {cloudflaredBinary,startQuickTunnel} from '../scripts/cloudflare-tunnel.mjs';
import {startDirect,deliverDirect} from '../scripts/direct-delivery.mjs';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,timeout=5000){const deadline=Date.now()+timeout;while(!check()){if(Date.now()>deadline)throw Error('Condition timed out.');await wait(10);}}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'apc-tunnel-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function executable(root){
 const path=join(root,'cloudflared-fixture.mjs');
 await writeFile(path,`import {readFileSync,writeFileSync} from 'node:fs';
 const file=process.env.FIXTURE_COUNTER;let n=0;try{n=Number(readFileSync(file));}catch{}writeFileSync(file,String(++n));
 console.error('ignore https://api.trycloudflare.com');
 process.stdout.write('https://receiver-'+n+'.trycloud');
 setTimeout(()=>console.log('flare.com'),5);
 if(!process.env.FIXTURE_UNREADY)setTimeout(()=>console.error('Registered tunnel connection connIndex=0'),80);
 setInterval(()=>{},1000);`);
 return path;
}
test('a printed URL is not readiness; a killed connector is replaced and fully reaped on abort',async t=>{
 const root=await fixture(t),program=await executable(root),children=[],events=[],controller=new AbortController();
 const tunnel=startQuickTunnel({origin:'http://127.0.0.1:12345',root,env:{FIXTURE_COUNTER:join(root,'counter'),TUNNEL_TOKEN:'must-not-be-forwarded'},signal:controller.signal,retryMs:10,
  resolveBinary:async()=>process.execPath,
  spawnImpl:(_binary,args,options)=>{assert.equal(options.env.TUNNEL_TOKEN,undefined);assert.ok(args.includes('http2'));const child=spawn(process.execPath,[program],options);children.push(child);return child;},
  onReady:async url=>events.push(url),onUnavailable:async()=>events.push('offline')});
 t.after(()=>tunnel.close());
 await until(()=>children.length===1);await wait(30);assert.equal(tunnel.state,'starting');assert.equal(events.length,0);
 await until(()=>tunnel.state==='ready');assert.equal(tunnel.endpoint,'https://receiver-1.trycloudflare.com');children[0].kill('SIGKILL');
 await until(()=>tunnel.endpoint==='https://receiver-2.trycloudflare.com');assert.deepEqual(events.slice(0,3),['https://receiver-1.trycloudflare.com','offline','https://receiver-2.trycloudflare.com']);
 controller.abort();await tunnel.close();assert.equal(tunnel.state,'stopped');assert.equal(events.at(-1),'offline');assert.ok(children.every(child=>child.exitCode!==null||child.signalCode));
});
test('failed edge readiness backs off without advertising an allocated URL',async t=>{
 const root=await fixture(t),program=await executable(root),children=[];let ready=0,offline=0;
 const tunnel=startQuickTunnel({origin:'http://127.0.0.1:12345',root,env:{FIXTURE_COUNTER:join(root,'counter'),FIXTURE_UNREADY:'1'},startupMs:150,retryMs:10,
  resolveBinary:async()=>process.execPath,spawnImpl:(_b,_a,options)=>{const child=spawn(process.execPath,[program],options);children.push(child);return child;},
  onReady:async()=>{ready++;},onUnavailable:async()=>{offline++;}});
 await until(()=>children.length>=2);await tunnel.close();assert.equal(ready,0);assert.ok(offline>=2);assert.ok(children.every(child=>child.exitCode!==null||child.signalCode));
});
test('official binary bootstrap verifies release digest, reuses cache, and detects tampering',async t=>{
 if(process.platform!=='linux')return;
 const root=await fixture(t),data=Buffer.from('official fixture binary'),digest='sha256:'+createHash('sha256').update(data).digest('hex');let downloads=0;
 const arch={x64:'amd64',arm64:'arm64',arm:'arm'}[process.arch],name='cloudflared-linux-'+arch;
 const fetchImpl=async url=>{if(String(url).includes('/releases/tags/'))return Response.json({assets:[{name,digest,browser_download_url:'https://github.com/cloudflare/cloudflared/releases/download/2026.9.1/'+name}]});downloads++;return new Response(data);};
 const options={root,env:{PATH:''},signal:new AbortController().signal,fetchImpl};
 const path=await cloudflaredBinary(options);assert.equal(await readFile(path,'utf8'),data.toString());await cloudflaredBinary(options);assert.equal(downloads,1);
 await writeFile(path,'tampered');await cloudflaredBinary(options);assert.equal(downloads,2);
 const wrong=await fixture(t);await assert.rejects(cloudflaredBinary({...options,root:wrong,fetchImpl:async url=>String(url).includes('/releases/tags/')?fetchImpl(url):new Response('bad download')}),/checksum mismatch/);
});
test('automatic direct receiver starts without waiting on a tunnel, verifies routing, and recovers a changed address',async t=>{
 const root=await fixture(t),calls=[],controller=new AbortController();let hooks,origin,wakes=0;
 const identity={url:'https://instance.invalid',principal_id:'agt_receiver',token:'private-fixture'};
 const request=async(url,options)=>{calls.push(options);return {registered:true,expires_in:1800};};
 const route=(url,options)=>fetch(String(url).replace(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com/,origin),options);
 const receiver=await startDirect({identity,root,env:{},signal:controller.signal,request,onWork:async()=>{wakes++;},fetchImpl:route,
  tunnelFactory:options=>{hooks=options;origin=options.origin;return {state:'starting',close:async()=>hooks.onUnavailable()};}});
 t.after(()=>receiver.close());assert.equal(receiver.configured,true);assert.equal(receiver.available,false);assert.equal(calls.length,0);
 await hooks.onReady('https://first.trycloudflare.com',controller.signal);assert.equal(receiver.available,true);assert.equal(calls[0].method,'POST');
 const key=JSON.parse(await readFile(join(root,'direct-key.json'))).key;
 const payload=JSON.stringify({recipient_id:identity.principal_id,expires_at:Date.now()+60000,message:{id:'msg_work'}}),signature=createHmac('sha256',key).update(payload).digest('hex');
 const hint={endpoint:receiver.endpoint,payload,signature};await deliverDirect([hint],{fetchImpl:route});await until(()=>wakes===1);await deliverDirect([hint],{fetchImpl:route});assert.equal(wakes,1);
 assert.equal((await route('https://first.trycloudflare.com/',{})).status,404);assert.equal((await route(hint.endpoint,{method:'POST',body:payload})).status,403);
 await hooks.onUnavailable();assert.equal(receiver.available,false);assert.equal(calls.at(-1).method,'DELETE');
 await hooks.onReady('https://second.trycloudflare.com',controller.signal);assert.equal(receiver.endpoint,'https://second.trycloudflare.com/agentpeerchat/direct');
 await Promise.all([receiver.close(),receiver.close()]);assert.equal(receiver.available,false);assert.equal(calls.at(-1).body.endpoint,'https://second.trycloudflare.com/agentpeerchat/direct');
 assert.equal(JSON.parse(await readFile(join(root,'direct-state.json'))).state,'stopped');
});
test('a tunnel capability failure never blocks creating the primary receiver; explicit opt-out is honored',async t=>{
 const root=await fixture(t);let attempts=0;
 const receiver=await startDirect({identity:{url:'https://instance.invalid',principal_id:'agt_fixture'},root,env:{},request:async()=>{throw Error('must not register');},onWork:async()=>{},
  tunnelFactory:options=>startQuickTunnel({...options,retryMs:10,resolveBinary:async()=>{attempts++;throw Error('Host offline');}})});
 await until(()=>attempts>=2);assert.equal(receiver.available,false);assert.equal(receiver.state,'retrying');await receiver.close();
 const disabled=await startDirect({env:{AGENTPEERCHAT_TUNNEL:'off'},root});assert.equal(disabled.configured,false);await disabled.close();
});
