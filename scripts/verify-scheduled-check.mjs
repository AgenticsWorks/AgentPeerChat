// Opt-in Linux/systemd verification. Runs real Codex turns and consumes model quota.
// The server, agent identities and timer are disposable; no production profile is used.
import {readFile,writeFile,mkdir,copyFile,chmod,rm} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes,randomUUID,randomInt,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import worker from '../dist/server/worker.mjs';
import {createApplication} from '../server/app.mjs';
const repo=process.cwd(),runId=randomUUID().slice(0,8),root=resolve('.wrangler/scheduled-check',runId);
let unit='agentpeerchat-'+createHash('sha256').update(join(root,'profile.json')).digest('hex').slice(0,16);
await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
function systemctl(...args){const r=spawnSync('systemctl',args,{encoding:'utf8'});if(r.status!==0)throw new Error('systemctl '+args[0]+': '+r.stderr);return r.stdout.trim();}
async function cliRun(args,env){return new Promise((done,reject)=>{const child=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.once('error',reject);child.once('exit',status=>done({status,stdout,stderr}));});}
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const base='http://127.0.0.1:'+port,secret=randomBytes(32).toString('hex');
const app=await createApplication({worker,databasePath:join(root,'data.sqlite'),setupSecret:secret,publicUrl:base,assetsDirectory:resolve('public'),migrationsDirectory:resolve('migrations')});
await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
const report={runId,success:false,scope:'Human owner message -> actual systemd timer -> native Codex model -> installed skill -> disposable SQLite API -> reply + ack',testIntervalSeconds:30,productionTasksCreated:0,checks:[]};
let owner;const messages=[];
async function api(path,key=owner,body){const r=await fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:{...(key?{Authorization:'Bearer '+key}:{}),...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{})},body:body?JSON.stringify(body):undefined});const d=await r.json();assert.ok(r.ok,path+' '+r.status);return d;}
try{
 const setup=await api('/setup',null,{name:'Verification owner',setup_secret:secret});owner=setup.access_key;
 const actor=await api('/agents',owner,{name:'Codex scheduled worker'}),peer={principal:setup.principal,token:{token:owner}};
 const profile=join(root,'profile.json');await writeFile(profile,JSON.stringify({url:base,principal_id:actor.principal.id,token:actor.token.token}),{mode:0o600});
 const auth=join(root,'codex-state');await mkdir(auth,{mode:0o700});await copyFile(join(process.env.CODEX_HOME||join(homedir(),'.codex'),'auth.json'),join(auth,'auth.json'));await chmod(join(auth,'auth.json'),0o600);
 await writeFile(join(auth,'config.toml'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n',{mode:0o600});
 const work=join(root,'work');await mkdir(join(work,'.agents','skills','agentpeerchat'),{recursive:true});
 const cli=resolve('cli/agentpeerchat.mjs');const installed=spawnSync(process.execPath,[cli,'skill','--install',join(work,'.agents','skills','agentpeerchat')],{encoding:'utf8'});assert.equal(installed.status,0);
 const codex=process.env.AGENTPEERCHAT_CODEX_CLI||'/root/.local/bin/codex';
 await writeFile(join(root,'run.mjs'),`import {spawn} from 'node:child_process';import{readFile,writeFile}from'node:fs/promises';const root=${JSON.stringify(root)};let n=0;try{n=Number(await readFile(root+'/count','utf8'))}catch{}n++;await writeFile(root+'/count',String(n));const child=spawn(${JSON.stringify(codex)},['exec','--ephemeral','--skip-git-repo-check','--sandbox','workspace-write','-c','sandbox_workspace_write.network_access=true','-c','approval_policy="never"','-c','shell_environment_policy.inherit="all"','--disable','apps','--json','-'],{cwd:root+'/work',env:{...process.env,CODEX_HOME:root+'/codex-state',AGENTPEERCHAT_CONFIG:root+'/profile.json'},stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);let prompt='';for await(const chunk of process.stdin)prompt+=chunk;child.stdin.end(prompt);child.on('error',e=>{console.error(e.name);process.exitCode=1});child.on('exit',async code=>{await writeFile(root+'/turn-'+n+'.jsonl',out,{mode:0o600});await writeFile(root+'/exit-'+n,JSON.stringify({code,stderr:err.slice(-2000)}),{mode:0o600});process.exitCode=code??1});`,{mode:0o600});
 const runnerFile=join(root,'runner.json');await writeFile(runnerFile,JSON.stringify({argv:[process.execPath,join(root,'run.mjs')],cwd:work,timeout_seconds:240}),{mode:0o600});
 const chat=(await api('/threads',peer.token.token,{kind:'direct',members:[actor.principal.id]})).thread;
 const thread=chat.id;
 async function sendTask(index){const weekly=randomInt(81,96),price=.035,monthly=weekly*22/5,cost=monthly*price,code='PLAN-'+runId+'-'+index;const message=(await api('/messages',peer.token.token,{thread_id:thread,type:'text',content:`请核对公开线索简报 ${code} 的预算：每周 ${weekly} 条，按每月 22 个工作日、每周 5 个工作日估算，每条模型费 0.035 元，模型月预算 50 元。请给出平均月用量、模型月费用、按整条向上取整的计划费用和预算结论。服务器费与每条人工审阅耗时未知，不要补成零。写明公式，并在回复中保留方案编号。` } )).message;messages.push({id:message.id,code,weekly,monthly,cost});}
 await sendTask(1);const scheduledInstall=await cliRun([cli,'skill','--install',join(work,'.agents','skills','agentpeerchat'),'--listen','--runner-file',runnerFile,'--every','30s','--system'],{...process.env,AGENTPEERCHAT_CONFIG:profile});assert.equal(scheduledInstall.status,0,scheduledInstall.stderr);const listenerStatus=JSON.parse(spawnSync(process.execPath,[cli,'listen','status'],{env:{...process.env,AGENTPEERCHAT_CONFIG:profile},encoding:'utf8'}).stdout);assert.equal(listenerStatus.active,true);unit=listenerStatus.task_id.replace(/\.timer$/,'');report.timerId=listenerStatus.task_id;report.checks.push('Installed the skill and actual CLI listener together; verified active timer without manually invoking its service');
 for(let turn=1;turn<=2;turn++){
  const deadline=Date.now()+300000;let accepted=false;
  while(Date.now()<deadline){await new Promise(r=>setTimeout(r,3000));try{const exited=JSON.parse(await readFile(join(root,'exit-'+turn),'utf8'));assert.equal(exited.code,0,'Native model turn must exit normally');const history=(await api('/threads/'+thread+'?after=0&limit=100',peer.token.token)).items;const fact=messages[turn-1];const replies=history.filter(m=>m.sender_id===actor.principal.id&&String(m.content).includes(fact.code));assert.ok(replies.length,'Scheduled native model must send a real peer reply');const text=replies.map(m=>String(m.content)).join('\n');assert.ok(text.includes(String(fact.monthly)),'Reply must use the task fixture quantity');assert.ok(text.includes(fact.cost.toFixed(2))||text.includes(String(fact.cost)),'Reply must compute actual cost');const details=await api('/messages/'+fact.id);assert.ok(details.receipts.some(r=>r.recipient_id===actor.principal.id&&r.acked_at),'Agent must acknowledge after processing');const events=(await readFile(join(root,'turn-'+turn+'.jsonl'),'utf8')).split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}});assert.ok(events.some(e=>e.type==='item.completed'&&e.item?.type==='command_execution'&&e.item.exit_code===0&&e.item.command.includes('SKILL.md')&&e.item.aggregated_output?.includes('name: agentpeerchat')),'Model must load installed skill');assert.ok(events.some(e=>e.type==='item.completed'&&e.item?.type==='command_execution'&&e.item.exit_code===0&&e.item.command.includes('summary --once')),'Scheduled summary must succeed even with a sandboxed profile directory');await writeFile(join(root,'conversation-'+turn+'.json'),JSON.stringify(history,null,2),{mode:0o600});report.checks.push('Timer-triggered turn '+turn+': native skill load, correct substantive reply and successful acknowledgment');accepted=true;break;}catch(e){if(e.code!=='ENOENT')throw e;}}
  assert.ok(accepted,'Timed out waiting for scheduled model turn');console.log('Timer-triggered round '+turn+' passed.');if(turn===1)await sendTask(2);
 }
 const autoEnv={...process.env,AGENTPEERCHAT_CONFIG:profile};
 const due=new Date(Date.now()+5000).toISOString();
 async function command(...parts){const result=await cliRun([cli,...parts],autoEnv);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
 const queued=await command('schedule','send',thread,'Scheduled substantive report '+runId+': both requested budget reviews are complete; unknown hosting and review costs remain to be checked.','--at',due);
 const cancelled=await command('schedule','send',thread,'CANCELLED-'+runId,'--at',due);await command('schedule','cancel',cancelled.job.id);
 const dispatchDeadline=Date.now()+90000;let delivered=false;
 while(Date.now()<dispatchDeadline){await new Promise(r=>setTimeout(r,3000));const listed=await command('schedule','list');if(listed.skipped)continue;const job=listed.jobs.find(j=>j.id===queued.job.id);if(job.completed_at){const history=(await api('/threads/'+thread+'?after=0&limit=100',peer.token.token)).items;assert.ok(history.some(m=>m.id===job.last_message_id&&m.sender_id===actor.principal.id&&String(m.content).includes('Scheduled substantive report')));assert.ok(!history.some(m=>String(m.content).includes('CANCELLED-'+runId)));assert.equal(Number(await readFile(join(root,'count'),'utf8')),2,'Idle scheduled send must not start another model');delivered=true;break;}}
 assert.ok(delivered,'Actual timer must dispatch the due outbox message');report.checks.push('Real timer dispatches queued message; cancellation suppresses delivery and no idle model turn is started');
 const state=JSON.parse(await readFile(join(root,'profile.json.automation','status.json'),'utf8'));assert.equal(state.success,true);report.listenerStatusVerified=true;const removal=await command('listen','remove');assert.equal(removal.removed,true);assert.equal((await command('listen','status')).active,false);report.listenerRemovedViaCLI=true;report.success=true;
}catch(error){report.error=error.message;process.exitCode=1;console.log('Scheduled verification failed: '+error.message);}
finally{
 try{systemctl('disable','--now',unit+'.timer');systemctl('stop',unit+'.service');}catch{}
 await rm('/etc/systemd/system/'+unit+'.timer',{force:true});await rm('/etc/systemd/system/'+unit+'.service',{force:true});try{systemctl('daemon-reload');}catch{}
 await app.close();await rm(join(root,'codex-state','auth.json'),{force:true});await rm(join(root,'profile.json'),{force:true});report.temporaryTimerRemoved=true;report.completedAt=new Date().toISOString();await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log('Evidence: '+join(root,'report.json'));
}
