import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile,writeFile,stat,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {createApplication} from '../server/app.mjs';
import {saveProfile,readProfile} from '../scripts/private-profile.mjs';

function environment(home,profile){
 const env={...process.env,HOME:home,CODEX_HOME:join(home,'.codex'),CLAUDE_CONFIG_DIR:join(home,'.claude'),CODEX_THREAD_ID:'',CLAUDECODE:'',CLAUDE_CODE_MESSAGING_SOCKET:'',NODE_USE_ENV_PROXY:'0'};
 for(const key of Object.keys(env))if(/^(AGENTPEERCHAT|AGENTGRAM|AGENTPENPAL)_/.test(key)||/^(https?|all)_proxy$/i.test(key)||/^npm_config_/i.test(key))delete env[key];
 env.AGENTPEERCHAT_CONFIG=profile;return env;
}
function run(file,args,env,input=''){
 return new Promise((done,reject)=>{
  const child=spawn(file,args,{env});let stdout='',stderr='';
  child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  child.on('error',reject);child.on('close',code=>done({code,stdout,stderr}));child.stdin.end(input);
 });
}

// A clean HOME replacement tests the client recovery contract, not any vendor's disk policy.
test('packaged CLI restores the same identity after deleting the entire original runtime HOME',{timeout:60000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'agentpeerchat-identity-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const profile=join(directory,'private-disk','identity.json'),homeA=join(directory,'runtime-a'),homeB=join(directory,'runtime-b');
 await mkdir(homeA);await mkdir(homeB);
 const bundle=await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'node',write:false});
 const worker=(await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
 const secret='identity-recovery-private-test-setup';
 const app=await createApplication({worker,setupSecret:secret,publicUrl:'http://127.0.0.1',databasePath:join(directory,'server.sqlite'),assetsDirectory:resolve('public'),migrationsDirectory:resolve('migrations')});
 await new Promise(done=>app.server.listen(0,'127.0.0.1',done));t.after(()=>app.close());
 const base='http://127.0.0.1:'+app.server.address().port;
 const reference=await fetch(base+'/references/identity-persistence.md');assert.equal(reference.status,200);
 assert.equal(await reference.text(),await readFile('skills/agentpeerchat/references/identity-persistence.md','utf8'));
 async function api(path,key,method='GET',body){
  const response=await fetch(base+'/api/v1'+path,{method,headers:{...(key?{Authorization:'Bearer '+key}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  assert.ok(response.ok,path);return response.json();
 }
 const owner=await api('/setup',null,'POST',{name:'Owner',setup_secret:secret});
 const invitation=await api('/pairings',owner.access_key,'POST',{name:'Dots'});
 const invite=base+'/#agent-invite='+encodeURIComponent(invitation.pairing.code);
 const seen=[];app.server.on('request',request=>seen.push(request.method+' '+request.url));
 async function install(home,selectedProfile=profile){
  const env=environment(home,selectedProfile),prefix=join(home,'tools');
  const result=await run('npm',['install','--global','--prefix',prefix,'--ignore-scripts','--no-audit','--no-fund',resolve('dist/agentpeerchat-cli.tgz')],env);
  assert.equal(result.code,0,result.stderr);return {env,cli:join(prefix,'bin','agentpeerchat')};
 }
 let runtime=await install(homeA);
 let result=await run(runtime.cli,['join','--invite',invite,'--manual'],runtime.env);
 assert.equal(result.code,0,result.stderr);
 const original=await readFile(profile,'utf8'),identity=JSON.parse(original);
 assert.equal(identity.principal_id,invitation.principal.id);assert.equal((await stat(profile)).mode&0o777,0o600);
 await assert.rejects(stat(join(homeA,'.config','agentpeerchat',identity.principal_id,'config.json')),{code:'ENOENT'});
 const skillDirectory=JSON.parse(result.stdout.match(/"skill_directory": ("(?:[^"\\]|\\.)*")/)[1]);
 assert.ok(skillDirectory.startsWith(homeA+'/'),'The replaceable skill is installed in this runtime');
 assert.ok(await readFile(join(skillDirectory,'references','identity-persistence.md'),'utf8'));
 result=await run(runtime.cli,['me'],runtime.env);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).principal.id,identity.principal_id);
 const counts=()=>({resolve:seen.filter(path=>path.endsWith('/pairings/resolve')).length,request:seen.filter(path=>path.endsWith('/pairings/request')).length,confirmation:seen.filter(path=>path==='POST /api/v1/messages').length});
 const initial=counts();assert.deepEqual(initial,{resolve:1,request:1,confirmation:1});

 // Public invitation resolution really refuses a consumed invitation.
 const expired=await fetch(base+'/api/v1/pairings/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:invitation.pairing.code})});
 assert.equal(expired.status,410);const before=counts();
 await rm(homeA,{recursive:true,force:true});await assert.rejects(stat(homeA),{code:'ENOENT'});
 runtime=await install(homeB);
 result=await run(runtime.cli,['join','--invite',invite,'--manual'],runtime.env);
 assert.equal(result.code,0,result.stderr);assert.deepEqual(counts(),before,'Restoring does not resolve, bind, or announce joining again');
 assert.equal(await readFile(profile,'utf8'),original,'Original profile is used without rewriting its key or metadata');
 result=await run(runtime.cli,['--profile',identity.principal_id,'me'],runtime.env);
 assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).principal.id,identity.principal_id);
 assert.equal((await api('/me',identity.token)).principal.id,identity.principal_id);
 result=await run(runtime.cli,['--profile','agt_other','me'],runtime.env);assert.notEqual(result.code,0);assert.match(result.stderr,/different Agent/);
 await assert.rejects(stat(join(homeB,'.config','agentpeerchat',identity.principal_id,'config.json')),{code:'ENOENT'});
 // Even a syntactically valid other deployment path must not receive the saved key.
 const requestCount=seen.length;
 result=await run(runtime.cli,['join','--invite',base+'/other/#agent-invite=agp_wrong','--manual'],runtime.env);
 assert.notEqual(result.code,0);assert.match(result.stderr,/different instance/);assert.equal(seen.length,requestCount);
 result=await run(runtime.cli,['join','--manual'],runtime.env,JSON.stringify({...identity,principal_id:'agt_other'}));
 assert.notEqual(result.code,0);assert.match(result.stderr,/different instance or Agent/);assert.equal(seen.length,requestCount);
 assert.equal(await readFile(profile,'utf8'),original);
 for(const output of [result.stdout,result.stderr])assert.ok(!output.includes(identity.token),'No credential in errors');

 // An interruption before optional approval must retain its original private proof, too.
 const pending=await api('/pairings',owner.access_key,'POST',{name:'Muse',approval_required:true});
 const pendingProfile=join(directory,'private-disk','muse.json');
 const pendingInvite=base+'/#agent-invite='+encodeURIComponent(pending.pairing.code);
 result=await run(runtime.cli,['join','--invite',pendingInvite,'--manual','--no-wait'],{...runtime.env,AGENTPEERCHAT_CONFIG:pendingProfile});
 assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/Pairing status: pending/);
 await assert.rejects(stat(pendingProfile),{code:'ENOENT'});
 const proofPath=join(directory,'private-disk','.agentpeerchat-join',pending.principal.id,'pending-pairing.json');
 const proof=JSON.parse(await readFile(proofPath,'utf8'));
 assert.equal((await stat(proofPath)).mode&0o777,0o600);
 const verification=result.stdout.match(/Code: ([A-Z0-9-]+)\./)?.[1];assert.ok(verification);
 const resolutions=counts().resolve;
 await rm(homeB,{recursive:true,force:true});
 await api('/pairings/'+pending.pairing.id+'/approve',owner.access_key,'POST',{verification_code:verification});
 const homeC=join(directory,'runtime-c');await mkdir(homeC);runtime=await install(homeC,pendingProfile);
 result=await run(runtime.cli,['join','--invite',pendingInvite,'--manual','--no-wait'],runtime.env);
 assert.equal(result.code,0,result.stderr);assert.equal(counts().resolve,resolutions,'Pending invitation locator survives loss of the original HOME');
 const resumed=JSON.parse(await readFile(pendingProfile,'utf8'));assert.equal(resumed.token,proof.token);assert.equal(resumed.principal_id,pending.principal.id);
 await assert.rejects(stat(proofPath),{code:'ENOENT'});
 result=await run(runtime.cli,['me'],runtime.env);assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout).principal.id,pending.principal.id);
 assert.equal(await readFile(profile,'utf8'),original,'Recovering another Agent never changes the original identity');
});

test('private profile saves are atomic, reject collisions, and preserve unreadable configurations',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'agentpeerchat-private-profile-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const path=join(directory,'private','identity.json');
 const first={url:'https://first.example',principal_id:'agt_first',token:'agt_fake_first'},second={url:'https://second.example',principal_id:'agt_second',token:'agt_fake_second'};
 const outcomes=await Promise.allSettled([saveProfile(path,first),saveProfile(path,second)]);
 assert.equal(outcomes.filter(outcome=>outcome.status==='fulfilled').length,1);
 const saved=await readProfile(path);assert.ok([first.principal_id,second.principal_id].includes(saved.principal_id));
 assert.equal((await stat(path)).mode&0o777,0o600);assert.deepEqual(await readdir(join(directory,'private')),['identity.json']);
 const original=await readFile(path,'utf8');
 await assert.rejects(saveProfile(path,saved.principal_id===first.principal_id?second:first),/different instance or Agent/);assert.equal(await readFile(path,'utf8'),original);
 await saveProfile(path,{...saved,token:'agt_fake_rotated'});assert.equal((await readProfile(path)).token,'agt_fake_rotated');
 await writeFile(path,'{truncated-private-config');
 await assert.rejects(saveProfile(path,first),/unreadable or invalid/);assert.equal(await readFile(path,'utf8'),'{truncated-private-config');
 const provider=join(directory,'vault-mounted.json');await writeFile(provider,JSON.stringify(first),{mode:0o600});
 const pointer=join(directory,'from-vault.json');await symlink(provider,pointer);
 assert.equal((await readProfile(pointer)).principal_id,first.principal_id);
 await assert.rejects(saveProfile(pointer,first),/credential provider/);assert.equal((await readProfile(pointer)).token,first.token);
});
