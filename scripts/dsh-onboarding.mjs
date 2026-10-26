import {readFile,writeFile,mkdir,rename,access,open,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,resolve,delimiter} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
const bundle='@agenticsworks/dsh-agentpeerchat';
const read=async p=>{try{return JSON.parse(await readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
async function write(p,text){await mkdir(dirname(p),{recursive:true,mode:0o700});const tmp=p+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,text,{mode:0o600});await rename(tmp,p);}finally{await rm(tmp,{force:true});}}
export function dshManifest(){return {name:bundle,version:'0.1.3',type:'module',main:'index.mjs',files:['index.mjs','cordis.patch.yml','LICENSE'],license:'MIT',dsh:{bundle:{patch:'./cordis.patch.yml'}},peerDependencies:{'@deepseek-ai/cordis':'^4.0.4','@deepseek-ai/dsh-agent':'^0.2.0-rc.2','@deepseek-ai/dsh-llm':'^0.2.0-rc.2','@deepseek-ai/dsh-session-query':'^0.2.0-rc.2'},engines:{node:'>=22.15.0'}};}
export function dshPatch(text,{profile,cli,seconds=1800,enabled=true}){
 const begin='# AgentPeerChat managed channel: begin',end='# AgentPeerChat managed channel: end';
 const first=text.indexOf(begin),last=text.indexOf(end);
 if((first<0)!==(last<0)||first>=0&&last<first)throw Error('Inspect the incomplete AgentPeerChat DSH patch before retrying.');
 const block=`${begin}\n- id: agentpeerchat\n  disabled: ${!enabled}\n  config:\n    profile: ${JSON.stringify(resolve(profile))}\n${cli?'    cli: '+JSON.stringify(resolve(cli))+'\n':''}    fallbackSeconds: ${seconds}\n${end}`;
 if(first>=0)return text.slice(0,first)+block+text.slice(last+end.length);
 // A new profile's empty patch is [] rather than a block list.
 const meaningful=text.split('\n').filter(line=>line.trim()&&!line.trim().startsWith('#')).join('\n').trim();
 if(meaningful==='[]')text=text.replace(/^\s*\[\]\s*$/m,'');
 else if(meaningful&&!meaningful.startsWith('-'))throw Error('The DSH patch must be a YAML entry list. Keep its existing configuration and add the channel through DSH.');
 return text.replace(/\s*$/,'')+'\n'+block+'\n';
}
async function run(file,args,env,{timeout=180000}={}){
 return new Promise((ok,fail)=>{
  const child=spawn(file,args,{env,stdio:['ignore','pipe','pipe']});let stdout='',size=0;
  child.stdout.on('data',d=>{size+=d.length;if(size<1024*1024)stdout+=d;});child.stderr.resume();
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
  child.once('error',()=>{clearTimeout(timer);fail(Error('The DSH executable could not be started.'));});
  child.once('close',code=>{clearTimeout(timer);code===0?ok(stdout):fail(Error('DSH plugin installation failed. Inspect this DSH profile’s native plugin-manager diagnostics; the identity and other receivers were not replaced.'));});
 });
}
export async function dshStatus(profile){
 const identity=await read(profile);if(!identity)return null;
 const root=profile+'.dsh-plugin',owner=await read(join(root,'owner.json')),state=await read(join(root,'status.json'));
 if(!owner&&!state)return null;
 let active=Number.isInteger(owner?.pid)&&owner.pid>0;
 if(active)try{process.kill(owner.pid,0);}catch(e){if(e.code==='ESRCH')active=false;else if(e.code!=='EPERM')throw e;}
 const expected=createHash('sha256').update(identity.url.replace(/\/$/,'')+'\n'+identity.principal_id).digest('hex').slice(0,32);
 const session='session-'+[expected.slice(0,8),expected.slice(8,12),expected.slice(12,16),expected.slice(16,20),expected.slice(20)].join('-');
 if(state?.session_id!==session||state?.principal_id&&state.principal_id!==identity.principal_id||state?.url&&state.url!==identity.url.replace(/\/$/,''))return {runtime:'dsh',active:false,connected:false,verified:false};
 const direct=await read(join(root,'direct-state.json'));if(direct&&!active){direct.available=false;direct.state='stopped';direct.endpoint=null;}
 const recent=Date.now()-Date.parse(state.last_heartbeat_at||state.connected_at||'')<120000;
 return {runtime:'dsh',active:Boolean(active),direct,scheduled_dispatch:Boolean(active&&state.scheduled_dispatch),connected:Boolean(active&&state.connected&&recent),session_id:session,processed:state.processed||0,last_processed_at:state.last_processed_at||null,last_error:state.last_error||null,verified:Boolean(active&&state.processed>0&&Number.isFinite(Date.parse(state.last_processed_at||''))&&!state.last_error)};
}
export async function setupDsh({profile,cli,env=process.env,seconds=1800,enabled=true,execute=run}={}){
 const name=env.AGENTPEERCHAT_DSH_PROFILE||env.DSH_PROFILE;
 if(!name||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name))throw Error('Select the actual DSH profile with --dsh-profile NAME, or run setup inside DSH so DSH_PROFILE is supplied.');
 const home=resolve(env.DSH_HOME||join(env.HOME||homedir(),'.dsh')),directory=join(home,'profiles',name);
 if(env.DSH_PROFILE_DIR&&resolve(env.DSH_PROFILE_DIR)!==directory)throw Error('The DSH profile directory does not match DSH_HOME and DSH_PROFILE.');
 const manifest=await read(join(directory,'package.json'));
 if(!manifest)throw Error('Initialize this DSH profile through DSH first; setup will not replace another profile or choose its model.');
 const old=await read(profile+'.onboarding.json');
 if(old?.dsh&&(old.dsh.profile!==name||old.dsh.home!==home))throw Error('This identity is already bound to another DSH profile. Keep its existing receiving owner.');
 const candidates=env.AGENTPEERCHAT_DSH_CLI?[resolve(env.AGENTPEERCHAT_DSH_CLI)]:[...(env.PATH||'').split(delimiter).filter(Boolean).map(p=>join(p,'dsh')),join(dirname(process.execPath),'dsh')];
 let executable;for(const candidate of candidates)if(await access(candidate,constants.X_OK).then(()=>true,()=>false)){executable=candidate;break;}
 if(!executable)throw Error('DSH is not installed on this host. Install DSH or set AGENTPEERCHAT_DSH_CLI to its existing executable.');
 const version=(await execute(executable,['--version'],env,{timeout:10000})).trim();
 if(!/^0\.2\./.test(version))throw Error('This native plugin supports the DSH 0.2 Agent/Session APIs. Use a compatible DSH installation; setup did not switch to Codex or Claude Code.');
 const patchPath=join(directory,'cordis.patch.yml');let original='';try{original=await readFile(patchPath,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 const nextPatch=dshPatch(original,{profile,cli,seconds,enabled});
 if(!enabled){await write(patchPath,nextPatch);return {profile:name,home,version,enabled:false,status:'manual'};}
 const listener=await read(join(profile+'.automation','listener.json'));
 if(listener)throw Error('This identity already has a CLI listener. Keep its receiver, or remove that listener before explicitly moving it to DSH; setup did not stop it.');
 const lock=await open(profile+'.dsh-setup.lock','wx',0o600).catch(e=>{if(e.code==='EEXIST')throw Error('DSH setup is already running for this identity.');throw e;});
 try{
  let code;for(const path of [join(dirname(cli),'agentpeerchat-dsh.mjs'),resolve(dirname(cli),'../public/agentpeerchat-dsh.mjs')]){
   try{code=await readFile(path,'utf8');break;}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  if(!code)throw Error('The CLI lacks its bundled DSH plugin. Update the CLI from your saved instance while preserving the identity.');
  const target=profile+'.dsh-package',entry=join(target,'index.mjs');let current;try{current=await readFile(entry,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  await write(entry,code);await write(join(target,'package.json'),JSON.stringify(dshManifest(),null,2)+'\n');
  for(const license of [join(dirname(cli),'LICENSE'),resolve(dirname(cli),'../LICENSE')]){try{await write(join(target,'LICENSE'),await readFile(license,'utf8'));break;}catch(e){if(e.code!=='ENOENT')throw e;}}
  await write(join(target,'cordis.patch.yml'),'- insert:\n    - id: agentpeerchat\n      name: '+JSON.stringify(bundle)+'\n');
  const installed=await access(join(directory,'node_modules',bundle,'package.json')).then(()=>true,()=>false);
  if(!installed||current!==code||!manifest.dsh?.profile?.bundles?.includes(bundle))await execute(executable,['plugin','--profile',name,'add',target],{...env,COREPACK_DEFAULT_TO_LATEST:env.COREPACK_DEFAULT_TO_LATEST||'0'});
  const after=await read(join(directory,'package.json'));
  if(!after?.dsh?.profile?.bundles?.includes(bundle))throw Error('DSH did not enable the native channel bundle. The saved identity remains unchanged.');
  if(original!==nextPatch)await write(patchPath,nextPatch);
  return {profile:name,home,version,enabled:true,package_directory:target,patch_path:patchPath,...await dshStatus(profile)};
 }finally{await lock.close();await rm(profile+'.dsh-setup.lock',{force:true});}
}
