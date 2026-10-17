import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';

// A terminal tool that delivers stdout only when the command exits must be able
// to show a pairing code before asking the human to approve it.
test('buffered terminal can request pairing, return its code, then finish after approval', {timeout:20000}, async t=>{
 const home=await mkdtemp(join(tmpdir(),'agentpeerchat-buffered-'));
 let approved=false,proofHash; const hashes=[];let authenticated=0;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;
  res.setHeader('Content-Type','application/json');
  if(req.url==='/api/v1/pairings/request'){
   const data=JSON.parse(raw);hashes.push(data.token_hash);proofHash??=data.token_hash;
   return res.end(JSON.stringify({principal:{id:'agt_buffered'},owner_id:'hum_fixture',token_id:'tok_fixture',pairing:{id:'pair_fixture',verification_code:'ABCD-1234',status:approved?'approved':'pending',expires_at:new Date(Date.now()+60000).toISOString()}}));
  }
  if(req.url==='/api/v1/pairings/pair_fixture/check')return res.end(JSON.stringify({principal:{id:'agt_buffered'},pairing:{id:'pair_fixture',verification_code:'ABCD-1234',status:'pending',expires_at:new Date(Date.now()+60000).toISOString()}}));
  if(req.url==='/api/v1/me'){
   authenticated++;assert.ok(approved,'No access before human approval');
   return res.end(JSON.stringify({principal:{id:'agt_buffered',kind:'agent',name:'Buffered fixture'}}));
  }
  if(req.url==='/api/v1/messages')return res.end(JSON.stringify({message:{id:'msg_fixture'}}));
  res.statusCode=404;res.end('{}');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(home,{recursive:true,force:true});});
 const packet={receiving:{mode:'manual'},url:`http://127.0.0.1:${server.address().port}`,principal_id:'agt_buffered',pairing:{id:'pair_fixture',code:'agp_fixture_invitation'}};
 async function run(){
  const env={...process.env,CODEX_HOME:join(home,'.codex'),CODEX_THREAD_ID:'',HOME:home,NODE_USE_ENV_PROXY:'0'};
  for(const k of Object.keys(env))if(/^(AGENTPEERCHAT|AGENTGRAM|AGENTPENPAL)_/.test(k))delete env[k];
  return await new Promise((resolveDone,reject)=>{
   const child=spawn(process.execPath,[resolve('cli/agentpeerchat.mjs'),'join','--no-wait'],{env,detached:process.platform!=='win32'});let stdout='',stderr='',timedOut=false;
   child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
   const timer=setTimeout(()=>{timedOut=true;if(process.platform==='win32')child.kill();else try{process.kill(-child.pid,'SIGTERM');}catch{}},5000);
   child.once('error',reject);child.once('close',code=>{clearTimeout(timer);resolveDone({code,stdout,stderr,timedOut});});child.stdin.end(JSON.stringify(packet));
  });
 }
 const profile=join(home,'.config','agentpeerchat','agt_buffered','config.json');
 const first=await run();
 assert.equal(first.timedOut,false,'join must return the verification code to a buffered tool before owner approval; it currently waits and hides it');
 assert.equal(first.code,0,first.stderr);assert.match(first.stdout,/ABCD-1234/);
 await assert.rejects(stat(profile),{code:'ENOENT'});assert.equal(authenticated,0);
 const proof=JSON.parse(await readFile(join(home,'.config','agentpeerchat','agt_buffered','pending-pairing.json'),'utf8'));
 assert.ok(!first.stdout.includes(proof.token));assert.ok(!first.stdout.includes(packet.pairing.code));
 approved=true;const second=await run();assert.equal(second.timedOut,false);assert.equal(second.code,0,second.stderr);
 assert.ok(authenticated>0);assert.ok(hashes.every(hash=>hash===proofHash),'Retry must reuse the same locally generated proof');
 assert.equal(JSON.parse(await readFile(profile,'utf8')).token,proof.token);assert.equal((await stat(profile)).mode&0o777,0o600);
 assert.ok(!second.stdout.includes(proof.token));
});
