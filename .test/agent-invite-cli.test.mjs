import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,stat,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

// A short invitation link must never move a device proof or a bearer credential to a second
// server, even when that server answers resolution with the first instance's public IDs.
const CODE='agp_fixture_invitation',PAIRING='pair_fixture',AGENT='agt_muse_fixture',OWNER='hum_owner_fixture',TOKEN_ID='tok_fixture';
const future=()=>new Date(Date.now()+10*60000).toISOString();
function instance(){
 const state={bound:null,approved:false,seen:[]};
 return {state,server:createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const body=raw?JSON.parse(raw):{};
  const record={method:req.method,url:req.url,authorization:req.headers.authorization||null,body};
  state.seen.push(record);
  res.setHeader('Content-Type','application/json');
  const fail=(status,message)=>{res.statusCode=status;res.end(JSON.stringify({error:{code:'invalid_pairing',message}}));};
  if(req.url==='/api/v1/pairings/resolve'){
   if(body.code!==CODE||state.approved||state.bound&&state.bound!=='resolved')return fail(410,'Pairing invitation expired, revoked, or already used.');
   return res.end(JSON.stringify({invitation:{id:PAIRING,status:state.bound?'pending':'invited',expires_at:future()},
    principal:{id:AGENT,name:'Muse',kind:'agent'},owner_id:OWNER,invited_by:'agt_dots_fixture',name_required:false}));
  }
  if(req.url==='/api/v1/pairings/request'){
   if(body.code!==CODE)return fail(410,'Pairing invitation is invalid.');
   if(!state.bound)state.bound=body.token_hash;
   else if(state.bound!==body.token_hash)return fail(410,'Pairing invitation is already used.');
   return res.end(JSON.stringify({principal:{id:AGENT,name:'Muse',kind:'agent'},owner_id:OWNER,token_id:TOKEN_ID,
    pairing:{id:PAIRING,verification_code:'MUSE-1234',status:state.approved?'approved':'pending',expires_at:future()}}));
  }
  if(req.url===`/api/v1/pairings/${PAIRING}/check`)
   return res.end(JSON.stringify({principal:{id:AGENT},owner_id:OWNER,token_id:TOKEN_ID,
    pairing:{id:PAIRING,verification_code:'MUSE-1234',status:state.approved?'approved':'pending',expires_at:future()}}));
  if(req.url==='/api/v1/me')return res.end(JSON.stringify({principal:{id:AGENT,kind:'agent',name:'Muse'}}));
  if(req.url==='/api/v1/messages')return res.end(JSON.stringify({message:{id:'msg_fixture'},replayed:false}));
  res.statusCode=404;res.end('{}');
 })};
}
function attacker(ids){
 // A different origin that knows the invitation code and echoes the real instance's public IDs.
 const seen=[];
 return {seen,server:createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const body=raw?JSON.parse(raw):{};
  seen.push({method:req.method,url:req.url,authorization:req.headers.authorization||null,body});
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/v1/pairings/resolve')
   return res.end(JSON.stringify({invitation:{id:ids.pairing,status:'invited',expires_at:future()},
    principal:{id:ids.agent,name:'Muse',kind:'agent'},owner_id:ids.owner,invited_by:'agt_dots_fixture',name_required:false}));
  if(req.url==='/api/v1/pairings/request')
   return res.end(JSON.stringify({principal:{id:ids.agent,name:'Muse',kind:'agent'},owner_id:ids.owner,token_id:'tok_attacker',
    pairing:{id:ids.pairing,verification_code:'FAKE-9999',status:'approved',expires_at:future()}}));
  if(req.url==='/api/v1/me')return res.end(JSON.stringify({principal:{id:ids.agent,kind:'agent',name:'Muse'}}));
  if(req.url==='/api/v1/messages')return res.end(JSON.stringify({message:{id:'msg_attacker'}}));
  res.statusCode=404;res.end('{}');
 })};
}
async function run(home,url,extra=[]){
 const env={...process.env,CODEX_HOME:join(home,'.codex'),CODEX_THREAD_ID:'',HOME:home,NODE_USE_ENV_PROXY:'0'};
 for(const key of Object.keys(env))if(/^(AGENTPEERCHAT|AGENTGRAM|AGENTPENPAL)_/.test(key))delete env[key];
 return await new Promise(done=>{
  const child=spawn(process.execPath,[resolve('cli/agentpeerchat.mjs'),'join','--invite',url,'--manual',...extra],{env,detached:process.platform!=='win32'});
  let stdout='',stderr='',timedOut=false;
  child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>{timedOut=true;if(process.platform==='win32')child.kill();else{try{process.kill(-child.pid,'SIGTERM');}catch{}}},15000);
  child.once('error',done);child.once('close',code=>{clearTimeout(timer);done({code,stdout,stderr,timedOut});});
  child.stdin.end();
 });
}
test('an invitation link never leaks its device proof or bearer to another server',{timeout:60000},async t=>{
 const real=instance(),evil=attacker({pairing:PAIRING,agent:AGENT,owner:OWNER});
 await new Promise(r=>real.server.listen(0,'127.0.0.1',r));
 await new Promise(r=>evil.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{real.server.closeAllConnections();evil.server.closeAllConnections();await new Promise(r=>real.server.close(r));await new Promise(r=>evil.server.close(r));});
 const realUrl=`http://127.0.0.1:${real.server.address().port}/#agent-invite=${CODE}`;
 const evilUrl=`http://127.0.0.1:${evil.server.address().port}/#agent-invite=${CODE}`;
 const home=await mkdtemp(join(tmpdir(),'agentpeerchat-invite-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const profile=join(home,'.config','agentpeerchat',AGENT,'config.json');
 const proofFile=join(home,'.config','agentpeerchat',AGENT,'pending-pairing.json');

 // 1. The recipient binds the real invitation and returns its code to a buffered terminal.
 const first=await run(home,realUrl,['--no-wait']);
 assert.equal(first.timedOut,false);assert.equal(first.code,0,first.stderr);
 assert.match(first.stdout,/MUSE-1234/);
 assert.ok(!first.stdout.includes(CODE),'the invitation code itself stays out of CLI output');
 const proof=JSON.parse(await readFile(proofFile,'utf8'));
 assert.match(proof.token,/^agt_[a-f0-9]{64}$/);
 assert.equal(proof.base,`http://127.0.0.1:${real.server.address().port}`);
 assert.ok(!first.stdout.includes(proof.token));
 await assert.rejects(stat(profile),{code:'ENOENT'});
 assert.ok(!real.state.seen.some(call=>call.authorization),'no authenticated request before approval');

 // 2. Reusing the same code against a different origin must not move the real proof anywhere.
 const redirected=await run(home,evilUrl,['--no-wait']);
 assert.equal(redirected.timedOut,false);assert.notEqual(redirected.code,0,'a cross-server reuse must fail, not join');
 assert.match(redirected.stderr,/different instance/);
 assert.ok(!evil.seen.some(call=>call.url==='/api/v1/pairings/request'),'the attacker never receives a proof hash');
 assert.ok(!evil.seen.some(call=>call.authorization),'the attacker never receives a bearer credential');
 assert.ok(!redirected.stdout.includes(proof.token)&&!redirected.stderr.includes(proof.token));
 assert.equal(JSON.parse(await readFile(proofFile,'utf8')).token,proof.token,'the local proof is left untouched');
 await assert.rejects(stat(profile),{code:'ENOENT'});

 // 3. After approval the same link finishes joining on the real instance only.
 real.state.approved=true;
 const second=await run(home,realUrl,['--no-wait']);
 assert.equal(second.timedOut,false);assert.equal(second.code,0,second.stderr||second.stdout);
 assert.ok(!second.stdout.includes(proof.token)&&!second.stderr.includes(proof.token),'no bearer key is printed');
 const saved=JSON.parse(await readFile(profile,'utf8'));
 assert.equal(saved.token,proof.token);assert.equal(saved.owner_id,OWNER);assert.equal((await stat(profile)).mode&0o777,0o600);
 const confirmation=real.state.seen.find(call=>call.url==='/api/v1/messages');
 assert.deepEqual(confirmation.body.to,[OWNER],'the join confirmation goes to the real instance owner');
 assert.equal(createHash('sha256').update(real.state.seen.find(call=>call.url==='/api/v1/me').authorization.slice(7)).digest('hex'),
  createHash('sha256').update(proof.token).digest('hex'),'the real instance sees the bound proof');
 assert.ok(!evil.seen.some(call=>call.authorization));

 // 4. Another device cannot consume the used link: resolution refuses it and nothing is sent.
 const competitor=await mkdtemp(join(tmpdir(),'agentpeerchat-invite-rival-'));
 t.after(()=>rm(competitor,{recursive:true,force:true}));
 const used=await run(competitor,realUrl,['--no-wait']);
 assert.equal(used.timedOut,false);assert.notEqual(used.code,0,'a used invitation must not join a second device');
 assert.match(used.stderr,/used|expired|invalid/i);
 await assert.rejects(stat(join(competitor,'.config','agentpeerchat',AGENT,'config.json')),{code:'ENOENT'});
 assert.ok(!real.state.seen.some(call=>call.authorization&&call.authorization.slice(7)!==proof.token));

 // 5. A fresh device pointed at the attacker mints its own new proof there; the real
 //    instance's credential never crosses over, and the working profile is never rewritten.
 const fooled=await run(competitor,evilUrl,['--no-wait']);
 assert.equal(fooled.timedOut,false);assert.equal(fooled.code,0,fooled.stderr);
 const evilProof=JSON.parse(await readFile(join(competitor,'.config','agentpeerchat',AGENT,'config.json'),'utf8')).token;
 assert.notEqual(evilProof,proof.token,'a fresh device mints its own proof');
 const evilRequest=evil.seen.find(call=>call.url==='/api/v1/pairings/request');
 assert.notEqual(evilRequest.body.token_hash,createHash('sha256').update(proof.token).digest('hex'));
 assert.ok(!evil.seen.some(call=>call.authorization===`Bearer ${proof.token}`));
 assert.ok(!fooled.stdout.includes(proof.token)&&!fooled.stderr.includes(proof.token));
 assert.equal(saved.token,proof.token,'the original working profile is untouched');
 });

// The delegated issuer side of the same lifecycle: create a short link, list it, approve it
// after the owner confirms the code, and explain a missing grant without asking for keys.
test('an agent with delegation creates, lists and approves its own invitation',{timeout:60000},async t=>{
 const issued={id:'pair_dots',code:'agp_dots_issued',url:'https://agent.example/#agent-invite=agp_dots_issued',expires_at:future()};
 const seen=[];
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  const body=raw?JSON.parse(raw):{};
  seen.push({method:req.method,url:req.url,authorization:req.headers.authorization||null,body});
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/v1/me')return res.end(JSON.stringify({principal:{id:'agt_dots',kind:'agent',name:'Dots',can_invite_agents:1}}));
  if(req.url==='/api/v1/pairings'&&req.method==='POST')
   return res.end(JSON.stringify({principal:{id:'agt_new',name:'Muse phone',kind:'agent',active:0,can_invite_agents:0},name_required:false,pairing:issued}));
  if(req.url==='/api/v1/pairings')return res.end(JSON.stringify({items:[{id:issued.id,principal_id:'agt_new',status:'pending',verification_code:'MUSE-1234',expires_at:issued.expires_at,created_by:'agt_dots',name:'Muse phone'}]}));
  if(req.url===`/api/v1/pairings/${issued.id}/approve`){
   assert.equal(body.verification_code,'MUSE-1234');
   return res.end(JSON.stringify({ok:true,replayed:false}));
  }
  if(req.url===`/api/v1/pairings/${issued.id}/reject`)return res.end(JSON.stringify({ok:true}));
  res.statusCode=404;res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const home=await mkdtemp(join(tmpdir(),'agentpeerchat-invite-issuer-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const profile=join(home,'config.json');
 await writeFile(profile,JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token:'agt_dots_key',principal_id:'agt_dots',token_id:'tok_dots',owner_id:'hum_owner'}));
 const run=extra=>new Promise(done=>{
  const env={...process.env,HOME:home,AGENTPEERCHAT_CONFIG:profile,NODE_USE_ENV_PROXY:'0'};
  for(const key of Object.keys(env))if(/^(AGENTGRAM|AGENTPENPAL)_/.test(key))delete env[key];
  const child=spawn(process.execPath,[resolve('cli/agentpeerchat.mjs'),...extra],{env});
  let stdout='',stderr='';
  child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  child.stdin.end();child.once('close',code=>done({code,stdout,stderr}));
 });
 const created=await run(['invite','create','Muse phone']);
 assert.equal(created.code,0,created.stderr);
 const output=JSON.parse(created.stdout);
 assert.equal(output.invitation.url,`http://127.0.0.1:${server.address().port}/#agent-invite=${issued.code}`);
 assert.equal(output.invitation.id,issued.id);
 assert.equal(output.invitation.expires_at,issued.expires_at);
 assert.ok(output.recipient_command.includes(output.invitation.url));
 assert.ok(output.connection_instructions.includes(`http://127.0.0.1:${server.address().port}/agentpeerchat-cli.tgz`));
 assert.ok(!JSON.stringify(output).includes('agt_dots_key'),'no bearer key is printed');
 const listed=await run(['invite','list']);
 assert.equal(listed.code,0,listed.stderr);
 assert.equal(JSON.parse(listed.stdout).items[0].verification_code,'MUSE-1234');
 const approved=await run(['invite','approve',issued.id,'MUSE-1234']);
 assert.equal(approved.code,0,approved.stderr);
 assert.deepEqual(JSON.parse(approved.stdout),{ok:true,replayed:false});
 assert.ok(seen.every(call=>call.authorization==='Bearer agt_dots_key'));
 const denied=await run(['invite','reject',issued.id]);
 assert.equal(denied.code,0,denied.stderr);
 });
