import {access,readFile,writeFile,mkdir,cp,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname,resolve,delimiter} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {automation} from './automation.mjs';
import {setupDsh} from './dsh-onboarding.mjs';
import {workbuddyWakePlan} from './native-wake.mjs';
export function setupOptions(args,env=process.env){
 const next={...env};let runtime,preference;const seen=new Set();
 for(let n=0;n<args.length;n++){
  const key=args[n],value=args[++n];
  if(seen.has(key))throw Error('Duplicate setup option '+key);seen.add(key);
  if(!value||value.startsWith('--'))throw Error('Missing '+key+' value.');
  if(key==='--runtime'&&['current','codex','claude','dsh','workbuddy'].includes(value)&&runtime===undefined)runtime=value;
  else if(key==='--dsh-profile')next.AGENTPEERCHAT_DSH_PROFILE=value;
  else if(key==='--workspace')next.AGENTPEERCHAT_WORKSPACE=resolve(value);
  else if(key==='--every'&&/^([1-9][0-9]*)(m|h)$/.test(value)){const match=value.match(/^(\d+)(m|h)$/);const minutes=Number(match[1])*(match[2]==='h'?60:1);if(minutes>1440)throw Error('Use an interval from 1m to 24h.');preference={mode:'interval',minutes};}
  else throw Error('Use setup [--runtime current|codex|claude|dsh|workbuddy] [--dsh-profile NAME] [--workspace PATH] [--every 30m].');
 }
 return {runtime,env:next,preference};
}
export async function detectRuntime(env=process.env){
 // WorkBuddy owns its model login and native task scheduler. Its embedded
 // CodeBuddy executable is not evidence of independently authenticated CLI access.
 if(env.DSH_SHELL==='1'&&env.DSH_PROFILE)return 'dsh';
 if(env.CODEBUDDY_HOST==='workbuddy-desktop')return 'workbuddy';
 const exists=async runtime=>{const override=env[runtime==='codex'?'AGENTPEERCHAT_CODEX_CLI':'AGENTPEERCHAT_CLAUDE_CLI'];return (await Promise.all((override?[override]:(env.PATH||'').split(delimiter).filter(Boolean).map(p=>join(p,runtime))).map(p=>access(p,constants.X_OK).then(()=>true,()=>false)))).some(Boolean);};
 // Prefer the invoking runtime over an unrelated executable also on PATH.
 const preferred=env.CODEX_THREAD_ID?'codex':env.CLAUDECODE||env.CLAUDE_CODE_MESSAGING_SOCKET?'claude':null;
 if(preferred&&await exists(preferred))return preferred;
 const available=[];for(const runtime of ['codex','claude'])if(await exists(runtime))available.push(runtime);
 return available.length===1?available[0]:null;
}
export async function installSkill({source,target,env=process.env,runtime}={}){
 const home=env.HOME||homedir();
 const directory=target?resolve(target):env.AGENTPEERCHAT_SKILL_DIRECTORY?resolve(env.AGENTPEERCHAT_SKILL_DIRECTORY):runtime==='dsh'?join(env.DSH_HOME||join(home,'.dsh'),'skills','agentpeerchat'):runtime==='workbuddy'?join(env.WORKBUDDY_CONFIG_DIR||join(home,'.workbuddy'),'skills','agentpeerchat'):runtime==='claude'?join(env.CLAUDE_CONFIG_DIR||join(home,'.claude'),'skills','agentpeerchat'):runtime==='codex'?join(env.CODEX_HOME||join(home,'.codex'),'skills','agentpeerchat'):join(home,'.agents','skills','agentpeerchat');
 await mkdir(directory,{recursive:true});
 await writeFile(join(directory,'SKILL.md'),await readFile(source,'utf8'));
 const references=join(dirname(source),'references');if(await access(references).then(()=>true,()=>false))await cp(references,join(directory,'references'),{recursive:true});
 return directory;
}
const read=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const save=async(path,value)=>{await mkdir(dirname(path),{recursive:true,mode:0o700});const tmp=path+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(tmp,path);};
export function legacyBuiltin(recipe,runtime){
 const argumentsByRuntime={
  codex:['exec','--ephemeral','--skip-git-repo-check','--sandbox','workspace-write','-c','sandbox_workspace_write.network_access=true','-c','approval_policy="never"','-c','shell_environment_policy.inherit="all"','--json','-'],
  claude:['-p','--no-session-persistence','--permission-mode','dontAsk','--allowedTools','Bash','Read','Write','Edit','Glob','Grep','Skill','WebSearch','WebFetch','--setting-sources','user,project','--verbose','--output-format','stream-json']
 };
 return !recipe?.mode&&recipe?.result_protocol===runtime&&argumentsByRuntime[runtime]!==undefined&&JSON.stringify(recipe.argv?.slice(1))===JSON.stringify(argumentsByRuntime[runtime]);
}
export async function onboard({profile,cli,skillSource,preference,env=process.env,runtime}={}){
 const statePath=profile+'.onboarding.json',previous=await read(statePath);
 // An explicitly selected manual preference survives upgrades and copied invite retries.
 const choice=['manual','interval'].includes(preference?.mode)?preference:previous?.receiving||preference||{mode:'auto',minutes:30};
 const selected=runtime&&runtime!=='current'?runtime:await detectRuntime(env);
 const skill=await installSkill({source:skillSource,runtime:selected,env});
 const report={receiving:choice,skill_directory:skill,runtime:selected,configured_at:new Date().toISOString(),...(previous?.dsh?{dsh:previous.dsh}:{})};
 const context={cli,env:{...env,AGENTPEERCHAT_CONFIG:profile}};
 try {
  let status=await automation('listen',['status'],context);
  if(choice.mode==='manual'){
   if(status.installed)await automation('listen',['remove'],context);
   if(previous?.dsh)report.dsh=await setupDsh({profile,cli,env,enabled:false});
   report.status='manual';
  } else if(selected==='dsh'){
   const minutes=choice.mode==='interval'?Number(choice.minutes):30;
   if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw Error('Invalid receiving interval (1..1440 minutes).');
   report.dsh=await setupDsh({profile,cli,env,seconds:minutes*60});
   report.status=report.dsh.active?'receiving_configured':'dsh_profile_ready';
   report.next=report.dsh.active?'DSH owns receiving. Verify a real reply and ACK.':'The native bundle and private profile path are configured. Start or reload this exact DSH profile through its normal host; keep its existing model and workspace.';
  } else if(status.native?.active){
   report.native=status.native;report.status='receiving_configured';
  } else if(status.installed){
   const settings=await read(join(profile+'.automation','listener.json'));
   const recipe=settings?.runner_file?await read(settings.runner_file):null;
   // Upgrade only our previous built-in runners; preserve custom commands and exact-session bindings.
   if(legacyBuiltin(recipe,selected)){
    report.listener=await automation('listen',['install','--runtime',selected,'--workspace',recipe.cwd,'--every',(settings.every_seconds||1800)+'s','--manager',status.manager,...(settings.system?['--system']:[])],context);
   }
   if(!status.active&&status.manager==='process')await automation('listen',['start'],context);
   report.listener=await automation('listen',['status'],context);report.status=report.listener.active?'receiving_configured':'needs_attention';
  } else if(selected==='workbuddy'&&!env.AGENTPEERCHAT_RUNNER_FILE){
   const identity=await read(profile);
   if(!/^agt_[A-Za-z0-9_]+$/.test(identity?.principal_id||''))throw Error('Invalid Agent identity.');
   report.status='native_wake_required';
   report.native_wake=workbuddyWakePlan({profile,cli,skill:join(skill,'SKILL.md'),workspace:env.AGENTPEERCHAT_WORKSPACE||process.cwd(),principalId:identity.principal_id,minutes:choice.mode==='interval'?Number(choice.minutes):30});
   report.next=report.native_wake.next;
  } else if(selected||env.AGENTPEERCHAT_RUNNER_FILE){
   const minutes=choice.mode==='interval'?Number(choice.minutes):30;
   if(!Number.isInteger(minutes)||minutes<1||minutes>1440)throw Error('Invalid receiving interval (1..1440 minutes).');
   const args=['install',...(env.AGENTPEERCHAT_RUNNER_FILE?['--runner-file',resolve(env.AGENTPEERCHAT_RUNNER_FILE)]:['--runtime',selected]),'--workspace',resolve(env.AGENTPEERCHAT_WORKSPACE||process.cwd()),'--every',minutes+'m'];
   // Only a runtime-provided exact session identifier may bind an existing conversation.
   // No temporary setup session is guessed from process lists or installation history.
   const hostedCodex=await readFile('/proc/1/comm','utf8').then(value=>value.trim()==='codex',()=>false);
   if(selected==='codex'&&env.CODEX_THREAD_ID&&(hostedCodex||env.AGENTPEERCHAT_SESSION_PERSISTENT==='1')&&!env.AGENTPEERCHAT_RUNNER_FILE){
    try{report.listener=await automation('listen',[...args,'--thread','current'],context);}catch{report.listener=await automation('listen',args,context);}
   }else if(selected==='claude'&&env.AGENTPEERCHAT_SESSION_PERSISTENT==='1'&&env.CLAUDE_CODE_MESSAGING_SOCKET&&!env.AGENTPEERCHAT_RUNNER_FILE){
    try{report.listener=await automation('listen',[...args,'--session-socket','current'],context);}catch{report.listener=await automation('listen',args,context);}
   }else report.listener=await automation('listen',args,context);
   report.status=report.listener.active?'receiving_configured':'needs_attention';
  }else{
   report.status='native_wake_required';
   report.next='Load the installed skill and create or reuse your platform native agent-turn task now, using a 30-minute fallback or the platform minimum. No further owner confirmation is needed. A CLI cannot manufacture a hosted wake API. Report its task ID and verify reply + ACK.';
  }
 }catch(error){report.status='needs_attention';report.reason=error.message;report.next='Identity is connected and the skill is installed. Read the skill and repair the existing listener or configure your platform native wake task now. Do not claim receiving is verified until a real reply + ACK succeeds.';}
 await save(statePath,report);return report;
}
