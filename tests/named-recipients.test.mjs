import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createApplication} from '../server/app.mjs';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'node',write:false});
const worker=(await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
const exec=promisify(execFile);
test('source and packaged CLI resolve names against real SQLite contacts and never guess ambiguous recipients',{timeout:30000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'agentpeerchat-names-'));
 const app=await createApplication({worker,databasePath:join(root,'store.sqlite'),setupSecret:'fixture-setup-secret-with-at-least-24-characters',publicUrl:'http://localhost:8787',assetsDirectory:resolve('public'),migrationsDirectory:resolve('migrations')});
 await new Promise(done=>app.server.listen(0,'127.0.0.1',done));
 t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+app.server.address().port;
 async function api(path,token,body,method=body?'POST':'GET'){
  const r=await fetch(url+'/api/v1'+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,path+' '+r.status);return r.json();
 }
 const owner=await api('/setup',null,{name:'Owner',setup_secret:'fixture-setup-secret-with-at-least-24-characters'});
 const agents=[];
 for(const name of ['Grok Bot','Muse','Dots'])agents.push(await api('/agents',owner.access_key,{name}));
 const [grok,muse,dots]=agents;
 const env={...process.env,HOME:root,AGENTPEERCHAT_CONFIG:'',AGENTPEERCHAT_URL:url,AGENTPEERCHAT_TOKEN:grok.token.token,NODE_USE_ENV_PROXY:'0'};
 for(const k of Object.keys(env))if(/^(AGENTGRAM_|AGENTPENPAL_)/.test(k))delete env[k];
 const run=(file,args)=>exec(process.execPath,[resolve(file),...args],{env});
 for(const file of ['cli/agentpeerchat.mjs','dist/cli/agentpeerchat.mjs']){
  const direct=JSON.parse((await run(file,['direct','@mUsE','Can you check the user preference before we publish?'])).stdout);
  const message=await api('/messages/'+direct.message.id,muse.token.token);assert.equal(message.message.sender_id,grok.principal.id);
  const group=JSON.parse((await run(file,['group','Launch review','@Muse',muse.principal.id])).stdout);
  await run(file,['add',group.thread.id,'@Dots',dots.principal.id]);
  const thread=await api('/threads/'+group.thread.id,muse.token.token);assert.equal(thread.thread.members.length,3);
  const report=JSON.parse((await run(file,['doctor'])).stdout);assert.equal(report.agent.id,grok.principal.id);assert.equal(report.state,'connected_manual_or_external');
 }
 const profile=join(root,'profile.json');await writeFile(profile,JSON.stringify({url,token:grok.token.token,principal_id:grok.principal.id}),{mode:0o600});
 const selected=JSON.parse((await exec(process.execPath,[resolve('cli/agentpeerchat.mjs'),'doctor'],{env:{...env,AGENTPEERCHAT_CONFIG:profile,AGENTPEERCHAT_TOKEN:'',AGENTPEERCHAT_URL:''}})).stdout);
 assert.equal(selected.connected,true);await assert.rejects(access(profile+'.automation'),{code:'ENOENT'});
 const secondMuse=await api('/agents',owner.access_key,{name:'Muse'});
 const count=async()=>(await app.database.prepare('SELECT COUNT(*) AS n FROM messages').first()).n;
 const before=await count();
 for(const args of [['direct','@Muse','Do not guess'],['direct','@Missing','No delivery'],['group','Ambiguous','@Dots','@Muse']])await assert.rejects(run('cli/agentpeerchat.mjs',args),e=>e.code===1&&/Ambiguous|not found/.test(e.stderr));
 assert.equal(await count(),before);
 await api('/principals/'+secondMuse.principal.id,owner.access_key,{active:false},'PATCH');
 assert.ok(JSON.parse((await run('cli/agentpeerchat.mjs',['direct','@Muse','Inactive duplicates are excluded.'])).stdout).message.id);
 const report=await exec(process.execPath,[resolve('cli/agentpeerchat.mjs'),'doctor'],{env:{...env,AGENTPEERCHAT_TOKEN:''}}).catch(e=>e);
 assert.equal(report.code,1);assert.equal(JSON.parse(report.stdout).state,'not_connected');
});
