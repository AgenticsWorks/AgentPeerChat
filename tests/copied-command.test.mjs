import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,symlink,readFile,stat,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,delimiter} from 'node:path';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import {createApplication} from '../server/app.mjs';
import {connectionInstructions} from '../public/connection-kit.js';

test('copied connection command works when npm global binaries are absent from PATH', {timeout:30000}, async t=>{
 const directory=await mkdtemp(join(tmpdir(),'agentpeerchat-copied-command-'));
 const home=join(directory,'home'),tools=join(directory,'npm tools'),minimalBin=join(directory,'path');
 for(const path of [home,minimalBin])await mkdir(path,{recursive:true});
 let npmPath=process.env.npm_execpath;
 if(!npmPath)for(const bin of process.env.PATH.split(delimiter)){const candidate=join(bin,'npm');if(await access(candidate).then(()=>true,()=>false)){npmPath=candidate;break;}}
 assert.ok(npmPath,'npm is required for copied-command verification');
 for(const [name,path] of [['node',process.execPath],['npm',npmPath],['sh','/bin/sh']])await symlink(path,join(minimalBin,name));
 const bundled=await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'node',write:false});
 const worker=(await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'))).default;
 const secret='copied-command-private-setup-secret';
 const app=await createApplication({worker,setupSecret:secret,publicUrl:'http://127.0.0.1',databasePath:join(directory,'data.sqlite'),assetsDirectory:resolve('public'),migrationsDirectory:resolve('migrations')});
 await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
 let child;t.after(async()=>{child?.kill('SIGTERM');await app.close();await rm(directory,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+app.server.address().port;
 async function api(path,key,method='GET',body){const response=await fetch(url+'/api/v1'+path,{method,headers:{...(key?{Authorization:'Bearer '+key}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert.ok(response.ok,path);return response.json();}
 const owner=await api('/setup',null,'POST',{name:'Owner',setup_secret:secret});
 const invitation=await api('/pairings',owner.access_key,'POST',{name:'Muse'});
 const instruction=connectionInstructions({url,principal:invitation.principal,pairing:invitation.pairing,ownerId:owner.principal.id});
 const script=instruction.match(/```sh\n([\s\S]*?)\n```/)[1];
 const env={...process.env,HOME:home,PATH:minimalBin,NODE_USE_ENV_PROXY:'0'};
 for(const key of Object.keys(env))if(/^(AGENTPEERCHAT|AGENTGRAM|AGENTPENPAL)_/.test(key)||/^(https?|all)_proxy$/i.test(key)||/^npm_config_/i.test(key))delete env[key];
 // Isolate the inner npm from the outer `npm test` process so its global prefix and cache are local.
 env.NPM_CONFIG_PREFIX=tools;
 async function runShell(source){
  return new Promise(done=>{
   child=spawn('/bin/bash',['-s'],{env});let stdout='',stderr='';
   child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
   child.on('exit',code=>done({code,stdout,stderr}));child.stdin.end(source);
  });
 }
 // The generated instruction is bounded for buffered tools: the first run returns the
 // pairing code without activating, and the owner approves before the second run finishes.
 const first=await runShell(script);
 assert.equal(first.code,0,first.stderr);
 const pending=(await api('/pairings',owner.access_key)).items.find(p=>p.id===invitation.pairing.id&&p.status==='pending');
 assert.ok(pending&&first.stdout.includes(pending.verification_code),'Copied command must launch the installed CLI and show its pairing code: '+first.stderr);
 assert.ok(!first.stdout.includes(invitation.pairing.code),'Pairing output must not expose the invitation code');
 const profile=join(home,'.config','agentpeerchat',invitation.principal.id,'config.json');
 await assert.rejects(stat(profile),{code:'ENOENT'});
 await api('/pairings/'+pending.id+'/approve',owner.access_key,'POST',{verification_code:pending.verification_code});
 // Re-running the joined command reuses the installed CLI and the locally saved proof.
 const second=await runShell(script.replace(/^npm install[^\n]*\n/,''));
 assert.equal(second.code,0,second.stderr);
 const saved=JSON.parse(await readFile(profile,'utf8'));assert.equal(saved.principal_id,invitation.principal.id);assert.equal((await stat(profile)).mode&0o777,0o600);
 assert.equal((await api('/me',saved.token)).principal.name,'Muse');
 const executable=second.stdout.match(/^CLI executable: (.+)$/m)?.[1];assert.ok(executable);
 // A later tool shell has its original PATH again. The installer provides a working absolute CLI.
 async function nextTool(args){
  child=spawn(process.execPath,[executable,...args],{env});let text='',error='';child.stdout.on('data',data=>text+=data);child.stderr.on('data',data=>error+=data);child.stdin.end();
  const code=await new Promise(done=>child.on('exit',done));assert.equal(code,0,error);return text;
 }
 assert.equal(await nextTool(['skill']),await readFile('skills/agentpeerchat/SKILL.md','utf8')+'\n');
 assert.equal(JSON.parse(await nextTool(['summary','--once'])).agent.id,invitation.principal.id);

 const inbox=(await api('/inbox',owner.access_key)).items;
 assert.ok(inbox.some(message=>message.sender_id===invitation.principal.id&&message.content.includes('joined')));
});
