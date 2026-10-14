// Explicit live verification: models themselves configure receiving from the installed skill.
// No timer-install command is supplied in a prompt or executed by this harness.
import {readFile,writeFile,mkdir,chmod,copyFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,randomInt} from 'node:crypto';
import assert from 'node:assert/strict';
const base=process.env.AGENTPEERCHAT_URL?.replace(/\/$/,''),owner=process.env.AGENTPEERCHAT_OWNER_TOKEN;
if(!base||!owner||!process.env.GLM_CODING_PLAN_API_KEY)throw new Error('Privately supply instance owner access and native client authentication. This opt-in test consumes model quota.');
const runId=randomUUID().slice(0,8),root=resolve('.wrangler/skill-onboarding-check',runId);
await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);
const report={runId,startedAt:new Date().toISOString(),backend:'Live Cloudflare Worker + D1',success:false,agents:[],checks:[],productionTasksCreated:0};
const privateKeys=[owner,process.env.GLM_CODING_PLAN_API_KEY];
const redact=s=>privateKeys.reduce((text,key)=>text.replaceAll(key,'[redacted]'),s);
const save=async()=>writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
async function api(path,method='GET',data,key=owner){
 for(let attempt=0;;attempt++)try{const r=await fetch(base+'/api/v1'+path,{method,headers:{...(key?{Authorization:'Bearer '+key}:{}),...(data?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(30000)});const result=await r.json();if(!r.ok){const e=new Error('API '+path+' '+r.status);e.status=r.status;throw e;}return result;}catch(e){if(method!=='GET'||attempt>=3||e.status&&e.status<500&&e.status!==429)throw e;await new Promise(r=>setTimeout(r,500*2**attempt));}
}
function start(argv,env,cwd,input,label){
 let out='',err='',finished=false;
 const child=spawn(argv[0],argv.slice(1),{cwd,env,stdio:['pipe','pipe','pipe'],detached:true});child.stdin.end(input);
 child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}},420000);timer.unref();
 const done=new Promise((resolveDone,reject)=>{child.once('error',reject);child.once('exit',async code=>{finished=true;clearTimeout(timer);await writeFile(join(root,label+'.jsonl'),redact(out),{mode:0o600});await writeFile(join(root,label+'.stderr'),redact(err),{mode:0o600});resolveDone({code,out});});});
 return {done,get output(){return out;},stop(){if(!finished)try{process.kill(-child.pid,'SIGTERM');}catch{}}};
}
const peers=[],processes=[];let cli;
async function command(peer,...args){const r=await start([process.execPath,cli,...args],peer.env,peer.work,'','command-'+randomUUID()).done;assert.equal(r.code,0);return JSON.parse(r.out);}
try{
 const tools=join(root,'tools');await mkdir(tools);const install=await start(['npm','install','--global','--prefix',tools,'--ignore-scripts','--no-audit','--no-fund',resolve('dist/agentpeerchat-cli.tgz')],process.env,root,'','package').done;assert.equal(install.code,0);cli=join(tools,'bin','agentpeerchat');
 report.cliVersion=JSON.parse(await readFile('package.json','utf8')).version;
 const ownerId=(await api('/me')).principal.id;
 for(const kind of ['codex','claude']){
  const home=join(root,kind),work=join(home,'work');await mkdir(work,{recursive:true});
  const invitation=await api('/pairings','POST',{name:(kind==='codex'?'Codex · 定时预算':'Claude Code · 定时调研')+' · '+runId});
  const peer={kind,id:invitation.principal.id,home,work};peers.push(peer);
  const env={...process.env,HOME:home,PATH:join(tools,'bin')+':'+process.env.PATH};
  for(const name of Object.keys(env))if(/^(AGENTPEERCHAT_|AGENTGRAM_|AGENTPENPAL_)/.test(name))delete env[name];
  delete env.GITHUB_TOKEN;delete env.CLOUDFLARE_API_TOKEN;delete env.CLOUDFLARE_ACCOUNT_ID;
  env.AGENTPEERCHAT_CODEX_CLI=process.env.AGENTPEERCHAT_CODEX_CLI||'/root/.local/bin/codex';env.AGENTPEERCHAT_CLAUDE_CLI=process.env.AGENTPEERCHAT_CLAUDE_CLI||resolve('.wrangler/cli-tools/node_modules/.bin/claude');
  const joiner=start([cli,'join'],env,work,JSON.stringify({url:base,principal_id:peer.id,pairing:invitation.pairing,register_name:false}),'join-'+kind);processes.push(joiner);
  let pending;for(let n=0;n<60;n++){pending=(await api('/pairings')).items.find(x=>x.id===invitation.pairing.id&&x.status==='pending');if(pending&&joiner.output.includes(pending.verification_code))break;await new Promise(r=>setTimeout(r,500));}
  assert.ok(pending&&joiner.output.includes(pending.verification_code));await api('/pairings/'+invitation.pairing.id+'/approve','POST',{verification_code:pending.verification_code});assert.equal((await joiner.done).code,0);
  peer.profile=join(home,'.config','agentpeerchat',peer.id,'config.json');peer.token=JSON.parse(await readFile(peer.profile,'utf8')).token;privateKeys.push(peer.token);env.AGENTPEERCHAT_CONFIG=peer.profile;
  if(kind==='codex'){
   env.CODEX_HOME=join(home,'codex-state');await mkdir(env.CODEX_HOME,{mode:0o700});await copyFile(join(process.env.CODEX_HOME||join(homedir(),'.codex'),'auth.json'),join(env.CODEX_HOME,'auth.json'));await chmod(join(env.CODEX_HOME,'auth.json'),0o600);await writeFile(join(env.CODEX_HOME,'config.toml'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n',{mode:0o600});delete env.GLM_CODING_PLAN_API_KEY;
  }else{
   env.CLAUDE_CONFIG_DIR=join(home,'.claude-config');await mkdir(env.CLAUDE_CONFIG_DIR,{mode:0o700});
   await writeFile(join(env.CLAUDE_CONFIG_DIR,'settings.json'),JSON.stringify({env:{ANTHROPIC_AUTH_TOKEN:process.env.GLM_CODING_PLAN_API_KEY,ANTHROPIC_BASE_URL:'https://open.bigmodel.cn/api/anthropic',ANTHROPIC_DEFAULT_SONNET_MODEL:'glm-5.3-flash',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}),{mode:0o600});
   await mkdir(join(work,'.claude'),{recursive:true});await writeFile(join(work,'.claude','settings.local.json'),JSON.stringify({permissions:{allow:['Read','Write','Skill','Bash(agentpeerchat:*)','Bash(node '+cli+':*)']}}),{mode:0o600});delete env.GLM_CODING_PLAN_API_KEY;delete env.CODEX_HOME;
  }
  peer.env=env;const skill=join(work,kind==='codex'?'.agents':'.claude','skills','agentpeerchat');
  assert.equal((await start([cli,'skill','--install',skill],env,work,'','skill-'+kind).done).code,0);
  report.agents.push({kind,principalId:peer.id,provider:kind==='codex'?'gpt-6.1-sol':'Claude Code client / GLM glm-5.3-flash'});
 }
 const research=peers[1],developer=peers[0],weekly=randomInt(81,98),price=.035,quantity=weekly*22/5,cost=quantity*price,code='SCHEDULE-'+runId;
 await writeFile(join(research.work,'research.md'),`你独有的客户资料：方案 ${code}，每周 ${weekly} 条公开线索，每月22个工作日，每周5个工作日，每条估计模型费用0.035元，模型预算50元。服务器费及人工审阅时间未知。用户偏好先看简报再决定是否发布，不允许自动发帖或购买。只通过通信向预算伙伴提供这些资料，不读取伙伴目录。`);
 console.log('Run '+runId+': models perform first-use onboarding from installed skills; no timer commands in prompts.');await save();
 for(const peer of peers){
  const prompt=`这是你第一次使用已绑定的 AgentPeerChat 集成，通信 CLI 在 PATH，通信 skill 已装在本工作目录的标准 skill 位置。请按集成的首次使用流程完成准备，报告真实状态。拥有者在接入时已选择每1分钟自动接收；这一选择仅在此首次配置中给出，后续业务消息不再重复。当前是获授权的隔离 Linux 管理员测试环境，可管理你自己的 per-profile systemd 系统任务，无需用户服务会话。你运行在 ${peer.kind==='codex'?'Codex':'Claude Code'}；使用当前已登录的运行器、当前工作目录和已保存私有配置。只管理自己的集成任务，不修改其他系统服务。凭据不能打印。你的职责是${peer.kind==='codex'?'预算核算，业务资料在调研伙伴处':'客户调研，research.md 是你的客户资料'}。稍后会有正常业务消息；准备好后结束本次初始化，不开始无期限前台等待。`;
  const argv=peer.kind==='codex'?[peer.env.AGENTPEERCHAT_CODEX_CLI,'exec','--ephemeral','--skip-git-repo-check','--sandbox','danger-full-access','-c','approval_policy="never"','-c','shell_environment_policy.inherit="all"','--disable','apps','--json','-']:[peer.env.AGENTPEERCHAT_CLAUDE_CLI,'-p','--no-session-persistence','--permission-mode','dontAsk','--allowedTools','Bash','Read','Write','Skill','--setting-sources','user,project','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--verbose','--output-format','stream-json'];
  const process=start(argv,peer.env,peer.work,prompt,'onboarding-'+peer.kind);processes.push(process);peer.bootstrap=process;
 }
 for(const peer of peers){const result=await peer.bootstrap.done;assert.equal(result.code,0);assert.ok(result.out.includes('SKILL.md')||result.out.includes('"skill":"agentpeerchat"'),'Native process must load the skill');assert.ok(result.out.includes('listen install'),'The model must itself invoke listener installation');const status=await command(peer,'listen','status');assert.equal(status.active,true);assert.equal(status.interval_seconds,60);peer.task=status.task_id;report.agents.find(a=>a.principalId===peer.id).taskId=peer.task;}
 report.checks.push('Both native processes loaded their installed skill and themselves installed active 60-second timers');await save();console.log('Both model-created timers are active. Sending ordinary business task without any scheduling instruction.');
 const task=(await api('/messages','POST',{to:[developer.id],type:'text',content:`请完成方案 ${code} 的预算核算。Claude Code · 定时调研 · ${runId} 保管客户用量、预算和偏好，请向它核对资料，再给我计算平均月用量、模型月费用与预算判断。服务器成本和审阅时间未知时，不要填成零。回复保留方案码。` } )).message;report.ownerTaskMessageId=task.id;await save();
 let completed=false;const deadline=Date.now()+600000;
 while(Date.now()<deadline){await new Promise(r=>setTimeout(r,5000));const threads=(await api('/threads?limit=100')).items.filter(t=>t.participants?.some(p=>peers.some(peer=>peer.id===p.id)));const histories=[];for(const t of threads)histories.push(await api('/threads/'+t.id+'?after=0&limit=100'));await writeFile(join(root,'conversations.json'),JSON.stringify(histories,null,2),{mode:0o600});
  const replies=histories.flatMap(h=>h.items).filter(m=>m.sender_id===developer.id&&m.thread_id===task.thread_id&&String(m.content).includes(code));const text=replies.map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');const receipt=await api('/messages/'+task.id);
  if(text.includes(String(quantity))&&(text.includes(String(cost))||text.includes(cost.toFixed(2)))&&receipt.receipts.some(r=>r.recipient_id===developer.id&&r.acked_at)){completed=true;break;}
 }
 assert.ok(completed,'Automatically awakened developer must consult peer and return the correct budget');
 const histories=JSON.parse(await readFile(join(root,'conversations.json'),'utf8')),messages=histories.flatMap(h=>h.items);
 const pair=histories.filter(h=>h.thread.members?.some(p=>p.id===developer.id)&&h.thread.members?.some(p=>p.id===research.id)).flatMap(h=>h.items);
 assert.ok(pair.some(m=>m.sender_id===developer.id));assert.ok(pair.some(m=>m.sender_id===research.id&&String(m.content).includes(String(weekly))));
 report.checks.push('Ordinary owner business task triggered timers; Codex consulted Claude through Cloudflare, used private research facts, replied correctly, and acknowledged work');
 for(const peer of peers){let status;for(let n=0;n<24;n++){status=await command(peer,'listen','status');if(status.last_model_check?.success&&status.last_check?.success)break;await new Promise(r=>setTimeout(r,2500));}assert.equal(status.task_id,peer.task);assert.ok(status.last_model_check?.model_started&&status.last_model_check.success,'Actual scheduled model turn must succeed');report.agents.find(a=>a.principalId===peer.id).lastModelCheck=status.last_model_check;}
 for(const m of messages){const r=await api('/messages/'+m.id);m.receipts=r.receipts;}await writeFile(join(root,'conversations.json'),JSON.stringify(histories,null,2),{mode:0o600});
 report.peerMessages=pair.length;report.success=true;
}catch(error){report.error=redact(error.message);process.exitCode=1;console.log('Verification failed: '+report.error);}
finally{
 for(const p of processes)p.stop();await Promise.allSettled(processes.map(p=>p.done));
 for(const peer of peers){if(peer.env&&cli){try{const status=await command(peer,'listen','status');await writeFile(join(root,'final-status-'+peer.kind+'.json'),JSON.stringify(status,null,2),{mode:0o600});}catch{}try{await command(peer,'listen','remove');}catch{report.cleanupError='A temporary listener needs inspection';}}try{await api('/principals/'+peer.id,'PATCH',{active:false});}catch{report.cleanupError='A temporary identity needs inspection';}
  for(const path of [join(peer.home,'codex-state'),join(peer.home,'.claude-config'),join(peer.home,'.config')])await rm(path,{recursive:true,force:true});}
 report.completedAt=new Date().toISOString();report.privateCredentialsRemoved=true;await save();console.log('Report: '+join(root,'report.json'));console.log(report.success?'PASS':'INCOMPLETE');
}
