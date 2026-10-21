import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const token='agt_synthetic_private_agent_key',thread='thr_fixture_chat',code='agl_'+'b'.repeat(64);
function run(cli,args,env){return new Promise((done,reject)=>{const child=spawn(process.execPath,[resolve(cli),...args],{env});let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.once('error',reject);const timer=setTimeout(()=>child.kill(),10000);child.once('close',exit=>{clearTimeout(timer);done({exit,stdout,stderr});});child.stdin.end();});}
for(const cli of ['cli/agentpeerchat.mjs','dist/cli/agentpeerchat.mjs'])test(`${cli}: chat and one-use login links preserve the instance base and keep Agent keys private`,async t=>{
 const calls=[];let denied=false,malformed=false;
 const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw||'{}');calls.push({path:req.url,key:req.headers.authorization,body});res.setHeader('Content-Type','application/json');
  if(denied){res.statusCode=403;res.end(JSON.stringify({error:{message:'Browser access was explicitly disabled for this Agent.'}}));return;}
  assert.equal(req.url,'/nested/chat/api/v1/owner-login-links');assert.equal(req.method,'POST');assert.equal(req.headers.authorization,'Bearer '+token);
  const fragment=malformed?'#owner-login=bad':`#owner-login=${code}${body.thread_id?'&thread='+body.thread_id:''}`;
  res.statusCode=201;res.end(JSON.stringify({login_link:{fragment,url:'https://untrusted.invalid/#access_key=do-not-follow',expires_at:new Date(Date.now()+600000).toISOString()}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const home=await mkdtemp(join(tmpdir(),'agentpeerchat-web-'));t.after(()=>rm(home,{recursive:true,force:true}));const config=join(home,'profile.json');const url=`http://127.0.0.1:${server.address().port}/nested/chat`;
 await writeFile(config,JSON.stringify({url,token}),{mode:0o600});const env={...process.env,HOME:home,NODE_USE_ENV_PROXY:'0'};for(const k of Object.keys(env))if(/^(AGENTPEERCHAT|AGENTGRAM|AGENTPENPAL)_/.test(k))delete env[k];env.AGENTPEERCHAT_CONFIG=config;
 let r=await run(cli,['web','--plain',thread],env);assert.equal(r.exit,0,r.stderr);assert.equal(JSON.parse(r.stdout).url,url+'/#thread='+thread);assert.equal(calls.length,0,'a stable link needs no API call');
 r=await run(cli,['web',thread],env);assert.equal(r.exit,0,r.stderr);const link=JSON.parse(r.stdout);assert.equal(link.url,url+'/#owner-login='+code+'&thread='+thread);assert.equal(link.single_use,true);assert.ok(!r.stdout.includes(token));assert.ok(!r.stdout.includes('untrusted.invalid'));assert.equal(calls[0].body.thread_id,thread);
 r=await run(cli,['web','--login',thread],env);assert.equal(r.exit,0,r.stderr);assert.equal(JSON.parse(r.stdout).single_use,true,'legacy flag remains an alias');
 assert.deepEqual(JSON.parse(await readFile(config,'utf8')),{url,token},'opening the browser preserves the paired identity');
 denied=true;r=await run(cli,['web','--login'],env);assert.equal(r.exit,1);assert.match(r.stderr,/explicitly disabled/);assert.ok(!r.stderr.includes(token));denied=false;
 malformed=true;r=await run(cli,['web','--login'],env);assert.equal(r.exit,1);assert.match(r.stderr,/Invalid sign-in link/);malformed=false;
 for(const bad of ['http://example.invalid','https://user:pass@example.invalid','https://example.invalid/?key=bad','https://example.invalid/#key=bad']){const count=calls.length;r=await run(cli,['web','--login'],{...env,AGENTPEERCHAT_URL:bad});assert.equal(r.exit,1);assert.equal(calls.length,count);assert.ok(!r.stderr.includes(token));}
 const beforeOverride=calls.length;r=await run(cli,['web','--login'],{...env,AGENTPEERCHAT_URL:url+'/other-instance'});assert.equal(r.exit,1);assert.match(r.stderr,/different instance/);assert.equal(calls.length,beforeOverride,'a saved key never moves to an overridden instance base');
 for(const args of [['web','--login','--login'],['web','--plain','--login'],['web','--plain','--plain'],['web','https://evil.invalid'],['web',thread,thread]]){r=await run(cli,args,env);assert.equal(r.exit,1);}
 await writeFile(config,JSON.stringify({url}),{mode:0o600});r=await run(cli,['web'],env);assert.equal(r.exit,1);assert.match(r.stderr,/saved Agent connection/);
 r=await run(cli,['web','--plain'],env);assert.equal(r.exit,0,r.stderr);assert.equal(JSON.parse(r.stdout).url,url+'/');
});
