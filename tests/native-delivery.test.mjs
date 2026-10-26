import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from 'esbuild';
import {createApplication} from '../server/app.mjs';
import {drainNative} from '../scripts/native-mailbox.mjs';
import {requestJSON} from '../scripts/client-transport.mjs';
import {startDirect,deliverDirect} from '../scripts/direct-delivery.mjs';
import {NativeRuntime,readState,writeState} from '../scripts/native-runtime.mjs';
import {dshPatch,setupDsh,dshStatus} from '../scripts/dsh-onboarding.mjs';
import {setupOptions,legacyBuiltin} from '../scripts/onboarding.mjs';
const bundle=await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'node',write:false});
const worker=(await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'apc-native-contract-'));const secret='native-delivery-private-setup-fixture';
 const app=await createApplication({worker,databasePath:join(root,'db.sqlite'),setupSecret:secret,publicUrl:'http://127.0.0.1',assetsDirectory:resolve('public'),migrationsDirectory:resolve('migrations')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});const url='http://127.0.0.1:'+app.server.address().port;
 const call=(path,token,body,extra={})=>requestJSON(url+'/api/v1'+path,{token,method:body?'POST':'GET',body,...extra});
 const owner=await call('/setup',null,{name:'Owner',setup_secret:secret});const a=await call('/agents',owner.access_key,{name:'Grok Bot'}),b=await call('/agents',owner.access_key,{name:'Muse'});
 const identity={url,principal_id:b.principal.id,token:b.token.token};
 const send=(content='Read project data, calculate the report, and return the comparison.')=>call('/messages',a.token.token,{to:[b.principal.id],type:'text',content},{send:true});
 return {root,app,url,call,owner,a,b,identity,send};
}
test('leases serialize two hosts; expiry fences stale replies and ACKs; foreign identities cannot reuse fence',async t=>{
 const f=await fixture(t);const first=await f.call('/receiver/lease',f.b.token.token,{holder:'holder_first_123456'});assert.equal(first.acquired,true);
 assert.equal((await f.call('/receiver/lease',f.b.token.token,{holder:'holder_second_123456'})).acquired,false);
 assert.equal((await f.call('/receiver/lease',f.b.token.token,{holder:'holder_first_123456'})).fence,first.fence);
 await f.app.database.prepare('UPDATE receiver_leases SET expires_at=0').run();const next=await f.call('/receiver/lease',f.b.token.token,{holder:'holder_second_123456'});assert.equal(next.acquired,true);assert.notEqual(next.fence,first.fence);
 const message=(await f.send()).message;
 await assert.rejects(f.call('/messages/'+message.id+'/ack',f.b.token.token,{}, {headers:{'X-AgentPeerChat-Receiver':first.fence}}),/409/);
 await assert.rejects(f.call('/messages',f.a.token.token,{thread_id:message.thread_id,type:'text',content:'Wrong identity'}, {send:true,headers:{'X-AgentPeerChat-Receiver':next.fence}}),/409/);
 await f.call('/messages/'+message.id+'/ack',f.b.token.token,{}, {headers:{'X-AgentPeerChat-Receiver':next.fence}});
});
test('uncertain reply commit and ACK are recovered from durable output, never rerun tools',async t=>{
 const f=await fixture(t);await f.send();let calls=0,fail=true;const engine={run:async()=>{calls++;return 'Meadow costs 367.40; Harbor costs 381.70.';},close:async()=>{}};
 const request=async(url,options)=>{const result=await requestJSON(url,options);if(url.endsWith('/messages')&&options.send&&fail){fail=false;throw Error('Connection lost after commit');}return result;};
 await assert.rejects(drainNative({identity:f.identity,root:f.root,engine,request}),/Connection lost/);assert.equal(calls,1);
 assert.equal((await f.call('/inbox',f.b.token.token)).items.length,1);
 const result=await drainNative({identity:f.identity,root:f.root,engine});assert.equal(result.acknowledged,1);assert.equal(calls,1);assert.equal((await f.call('/inbox',f.b.token.token)).items.length,0);
 assert.equal((await f.call('/inbox',f.a.token.token)).items.length,1);
});
test('burst inputs remain FIFO; a failed model or oversized output never acknowledges work',async t=>{
 const f=await fixture(t);await f.send('one');await f.send('two');const order=[];
 await drainNative({identity:f.identity,root:f.root,engine:{run:async({message})=>{order.push(message.content);return 'Report '+message.content;},close:async()=>{}}});assert.deepEqual(order,['one','two']);
 await f.send('three');await assert.rejects(drainNative({identity:f.identity,root:f.root,engine:{run:async()=>{throw Error('Provider down');},close:async()=>{}}}),/Provider down/);assert.equal((await f.call('/inbox',f.b.token.token)).items.length,1);
});
test('direct send is mailbox-backed, authenticated, deduplicated, and survives a failed endpoint',async t=>{
 const f=await fixture(t);let wakes=0;const probe=await import('node:net');const socket=probe.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const endpoint='http://127.0.0.1:'+port+'/agentpeerchat/direct';
 const receiver=await startDirect({identity:f.identity,root:f.root,env:{AGENTPEERCHAT_DIRECT_URL:endpoint},request:requestJSON,onWork:async()=>{wakes++;}});t.after(()=>receiver.close());assert.equal(receiver.available,true);
 const result=await f.send();assert.equal(wakes,1);assert.equal((await f.call('/inbox',f.b.token.token)).items.length,1);
 await deliverDirect(result.direct);assert.equal(wakes,1);
 const forbidden=await fetch(endpoint,{method:'POST',body:result.direct[0].payload,headers:{'X-AgentPeerChat-Signature':'0'.repeat(64)}});assert.equal(forbidden.status,403);assert.equal(wakes,1);
 const key=JSON.parse(await readFile(join(f.root,'direct-key.json'))).key;
 const spoof=JSON.parse(result.direct[0].payload);spoof.recipient_id=f.a.principal.id;const {createHmac}=await import('node:crypto');const raw=JSON.stringify(spoof);
 assert.equal((await fetch(endpoint,{method:'POST',body:raw,headers:{'X-AgentPeerChat-Signature':createHmac('sha256',key).update(raw).digest('hex')}})).status,403);
 await receiver.close();const offline=await f.send('Recipient offline');assert.ok(offline.message.id);assert.equal((await f.call('/inbox',f.b.token.token)).items.length,2);
 // Stale but valid discovery still cannot lose the durable message.
 await f.call('/receiver/direct',f.b.token.token,{endpoint,signing_key:key});const fallback=await f.send('Direct endpoint unavailable');assert.ok(fallback.message.id);assert.equal((await f.call('/inbox',f.b.token.token)).items.length,3);
});
test('stale connector shutdown cannot delete a newer endpoint or receiver incarnation',async t=>{
 const f=await fixture(t),first='https://first.trycloudflare.com/agentpeerchat/direct',second='https://second.trycloudflare.com/agentpeerchat/direct',key='a'.repeat(64),newKey='b'.repeat(64);
 const registered=await f.call('/receiver/direct',f.b.token.token,{endpoint:first,signing_key:key});assert.equal(registered.expires_in,1800);
 await f.call('/receiver/direct',f.b.token.token,{endpoint:second,signing_key:key});
 await f.call('/receiver/direct',f.b.token.token,{endpoint:first,signing_key:key},{method:'DELETE'});
 let row=await f.app.database.prepare('SELECT endpoint FROM direct_receivers WHERE principal_id=?').bind(f.b.principal.id).first();assert.equal(row.endpoint,second);
 await f.call('/receiver/direct',f.b.token.token,{endpoint:second,signing_key:newKey});
 await f.call('/receiver/direct',f.b.token.token,{endpoint:second,signing_key:key},{method:'DELETE'});
 row=await f.app.database.prepare('SELECT signing_key FROM direct_receivers WHERE principal_id=?').bind(f.b.principal.id).first();assert.equal(row.signing_key,newKey);
});
test('native protocol preserves exact sessions, serializes work, and does not treat acceptance as completion',async t=>{
 const root=await mkdtemp(join(tmpdir(),'apc-native-protocol-'));t.after(()=>rm(root,{recursive:true,force:true}));let active=0,max=0,starts=0,resumes=0;
 const sessions=new Map();
 const spawnPeer=()=>{const p={child:{pid:100+starts},listeners:new Set(),closed:false,send:()=>{},close:async()=>{p.closed=true;},request:async(method,params)=>{
  if(method==='initialize')return {};
  if(method==='thread/start'){starts++;sessions.set('native_one',[]);return {thread:{id:'native_one'}};}
  if(method==='thread/resume'){resumes++;assert.equal(params.threadId,'native_one');return {};}
  if(method==='skills/list')return {data:[{skills:[{name:'agentpeerchat',enabled:true,path:'/private/skill/SKILL.md'}]}]};
  if(method==='thread/read')return {thread:{turns:sessions.get(params.threadId)}};
  if(method==='turn/start'){max=Math.max(max,++active);const id='turn_'+Date.now();setTimeout(()=>{active--;const turn={id,status:'completed',items:[{type:'agentMessage',text:'A substantive report.'}]};sessions.get(params.threadId).push(turn);for(const fn of p.listeners)fn({method:'turn/completed',params:{threadId:params.threadId,turn}});},20);return {turn:{id,status:'inProgress'}};}
  throw Error(method);
 }};return p;};
 const opts={runner:{argv:['/native/codex'],cwd:root,result_protocol:'codex',timeout_seconds:10},root,identity:{url:'https://private.example',principal_id:'agt_one'},spawnPeer};let engine=new NativeRuntime(opts);
 const task=n=>({message:{id:'msg_'+n,thread_id:'thr_one',content:'Analyze'},thread:{id:'thr_one'},checkpoint:{phase:'queued',save:async()=>{}}});
 assert.deepEqual(await Promise.all([engine.run(task('a')),engine.run(task('b'))]),['A substantive report.','A substantive report.']);assert.equal(starts,1);assert.equal(max,1);await engine.close();
 engine=new NativeRuntime(opts);await engine.run(task('c'));assert.equal(starts,1);assert.equal(resumes,1);await engine.close();
 const ambiguous=task('unknown');ambiguous.checkpoint.phase='running';await assert.rejects(new NativeRuntime(opts).run(ambiguous),/acceptance was interrupted/);
});
test('DSH setup selects actual profile, preserves patches, and rejects duplicate options and incompatible hosts',async t=>{
 assert.equal(legacyBuiltin({result_protocol:'codex',argv:['/private/custom','exec','--json','-']},'codex'),false);
 assert.equal(legacyBuiltin({result_protocol:'claude',argv:['/private/custom','-p','--no-session-persistence','--output-format','stream-json']},'claude'),false);
 assert.equal(setupOptions(['--runtime','dsh','--dsh-profile','chosen'],{AGENTPEERCHAT_DSH_PROFILE:'old'}).env.AGENTPEERCHAT_DSH_PROFILE,'chosen');assert.throws(()=>setupOptions(['--workspace','/a','--workspace','/b']),/Duplicate/);
 const patch=dshPatch('- id: existing\n  config:\n    value: keep\n',{profile:'/private/profile.json'});assert.match(patch,/value: keep/);assert.equal(dshPatch(patch,{profile:'/private/profile.json'}),patch);
 const root=await mkdtemp(join(tmpdir(),'apc-dsh-onboarding-'));t.after(()=>rm(root,{recursive:true,force:true}));const directory=join(root,'profiles/headless');await mkdir(directory,{recursive:true});await writeFile(join(directory,'package.json'),'{}');
 await assert.rejects(setupDsh({profile:join(root,'identity.json'),cli:resolve('cli/agentpeerchat.mjs'),env:{DSH_HOME:root,DSH_PROFILE:'headless',AGENTPEERCHAT_DSH_CLI:process.execPath},execute:async()=> '0.1.5-rc.2'}),/0.2/);
});
test('Claude streaming reuses a process, resumes the exact session, and retains failures without ACK',async t=>{
 const root=await mkdtemp(join(tmpdir(),'apc-claude-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));let launches=0,mode='success';const args=[];
 const spawnPeer=(argv,options)=>{assert.equal(options.env.CLAUDECODE,undefined);assert.equal(options.env.CLAUDE_CODE_MESSAGING_SOCKET,undefined);assert.equal(options.env.CLAUDE_CONFIG_DIR,'/private/claude');launches++;args.push(argv);const p={child:{pid:launches},listeners:new Set(),closed:false,close:async()=>{p.closed=true;},send:m=>{if(m.type!=='user')return;setTimeout(()=>{for(const fn of p.listeners)fn({type:'result',session_id:m.session_id,subtype:mode==='provider_error'?'error_during_execution':'success',is_error:mode==='provider_error',result:'Verified calculation result.',permission_denials:mode==='denied'?[{tool_name:'Write'}]:[]});},1);}};return p;};
 const opts={runner:{argv:['/native/claude'],cwd:root,result_protocol:'claude',timeout_seconds:10},root,identity:{url:'https://private.example',principal_id:'agt_one'},spawnPeer,env:{CLAUDECODE:'1',CLAUDE_CODE_MESSAGING_SOCKET:'/temporary/setup.sock',CLAUDE_CONFIG_DIR:'/private/claude'}};
 const task=id=>({message:{id,thread_id:'thr_claude',content:'Analyze'},thread:{id:'thr_claude'},checkpoint:{phase:'queued',save:async()=>{}}});
 let engine=new NativeRuntime(opts);assert.equal(await engine.run(task('msg_first')),'Verified calculation result.');assert.equal(await engine.run(task('msg_second')),'Verified calculation result.');assert.equal(launches,1);await engine.close();
 engine=new NativeRuntime(opts);await engine.run(task('msg_third'));assert.ok(args[1].includes('--resume'));assert.equal(args[0].at(-1),args[1].at(-1));assert.ok(args[0].includes('user,project'));assert.ok(args[0].includes('Skill'));
 mode='denied';const denied=task('msg_denied');await assert.rejects(engine.run(denied),/did not complete successfully/);assert.equal(denied.checkpoint.phase,'queued');
 mode='provider_error';await assert.rejects(engine.run(task('msg_provider')),/did not complete successfully/);await engine.close();
 const uncertain=task('msg_uncertain');uncertain.checkpoint.phase='running';await assert.rejects(new NativeRuntime(opts).run(uncertain),/acceptance was interrupted/);
});
