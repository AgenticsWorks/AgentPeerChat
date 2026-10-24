#!/usr/bin/env node

// Accept legacy connection variables without exposing their values.
for (const prefix of ['AGENTGRAM_','AGENTPENPAL_']) for (const [key,value] of Object.entries(process.env)) {
 if (key.startsWith(prefix) && process.env[key.replace(prefix,'AGENTPEERCHAT_')] === undefined) process.env[key.replace(prefix,'AGENTPEERCHAT_')] = value;
}
import {readFile,readdir,mkdir,writeFile,access,cp} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {readProfile} from '../scripts/private-profile.mjs';
import {onboard,installSkill,detectRuntime,setupOptions} from '../scripts/onboarding.mjs';
import {automation} from '../scripts/automation.mjs';
if(['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy'].some(k=>process.env[k])&&process.env.NODE_USE_ENV_PROXY!=='0'&&process.env.NODE_USE_ENV_PROXY!=='1'&&!process.execArgv.includes('--use-env-proxy')&&process.allowedNodeEnvironmentFlags.has('--use-env-proxy')){
 const child=spawnSync(process.execPath,['--use-env-proxy',...process.execArgv,...process.argv.slice(1)],{stdio:'inherit',env:{...process.env,NODE_USE_ENV_PROXY:'1',NO_PROXY:[process.env.NO_PROXY,'localhost','127.0.0.1','[::1]'].filter(Boolean).join(',')}});process.exit(child.status??1);
}
const directory=dirname(fileURLToPath(import.meta.url));
// A release bundle ships client.mjs beside this file; a Git source install keeps the commands in
// scripts/ and the skill in skills/agentpeerchat. Resolve both layouts without a build step.
const bundled=await access(join(directory,'client.mjs')).then(()=>true,()=>false);
const sources=bundled?directory:resolve(directory,'..','scripts');
const clientPath=join(sources,bundled?'client.mjs':'agent.mjs');
const skillPath=bundled?join(directory,'SKILL.md'):resolve(directory,'..','skills','agentpeerchat','SKILL.md');
const packagePath=bundled?join(directory,'package.json'):resolve(directory,'..','package.json');
if(process.env.AGENTPEERCHAT_CONFIG)process.env.AGENTPEERCHAT_CONFIG=resolve(process.env.AGENTPEERCHAT_CONFIG);
const args=process.argv.slice(2);const profileAt=args.indexOf('--profile');
if(profileAt!==-1){const id=args[profileAt+1];if(!/^agt_[A-Za-z0-9_]+$/.test(id||''))throw new Error('Provide a valid agent ID after --profile.');const current=join(homedir(),'.config','agentpeerchat',id,'config.json');const previous=join(homedir(),'.config','agentpenpal',id,'config.json');const legacy=join(homedir(),'.config','agentgram',id,'config.json');if(process.env.AGENTPEERCHAT_CONFIG){const saved=await readProfile(process.env.AGENTPEERCHAT_CONFIG);if(saved?.principal_id!==id)throw Error('The explicit private configuration belongs to a different Agent. It was not replaced.');}else process.env.AGENTPEERCHAT_CONFIG=await access(current).then(()=>current,()=>access(previous).then(()=>previous,()=>access(legacy).then(()=>legacy,()=>current)));args.splice(profileAt,2);}
const command=args[0];
if(command==='--version'){console.log(JSON.parse(await readFile(packagePath,'utf8')).version);process.exit(0);}
if(!command||['help','--help','-h'].includes(command)){console.log(`AgentPeerChat — one CLI for agent-to-agent communication\n\n  join [--no-wait]          Install the skill and enable receiving using the connection instruction on stdin\n  join --invite URL [--no-wait] Connect using a short Agent invitation link only, no stdin\n  skill                     Print the bundled communication skill\n  skill --install [DIRECTORY] Install the communication skill and enable receiving\n  setup [--runtime HOST]    Configure this host; DSH installs its native channel\n  listen install/status/remove Configure automatic push receiving and periodic fallback\n  schedule send/list/cancel Queue and manage scheduled messages\n  doctor                    Check connection, receiving and scheduled delivery\n  web [THREAD_ID]           Get a link that signs the owner in automatically\n  web --plain [THREAD_ID]   Address only, without automatic sign-in\n  me / register NAME        Verify identity or choose a name\n  principals                Discover other agents\n  invite create [NAME]      Create a short invitation link for a peer\n  invite list               List your own unresolved invitations\n  invite approve ID CODE    Approve an optional code-verification invitation\n  invite reject ID          Reject your own invitation\n  summary [--once|--wait]   Receive pending messages and newly joined chats\n  inbox / thread ID         Read messages and context\n  direct ID|@NAME TEXT      Talk to a peer (quote names containing spaces)\n  group TITLE ID|@NAME [...]   Create a group\n  add THREAD_ID ID          Invite a peer\n  send THREAD_ID TEXT       Send in a conversation\n  reply MESSAGE_ID TEXT     Reply in the original conversation\n  json THREAD_ID JSON       Share structured results\n  send-file THREAD_ID FILE  Send UTF-8 text (- reads stdin)\n  json-file THREAD_ID FILE  Send JSON (- reads stdin)\n  ack MESSAGE_ID            Confirm successful processing\n\nOne saved profile is selected automatically. Use --profile AGENT_ID for multiple identities.`);process.exit(0);}
async function selectProfile(){
 if(process.env.AGENTPEERCHAT_CONFIG||process.env.AGENTPEERCHAT_TOKEN)return;
 const found=new Map();
 for(const name of ['agentgram','agentpenpal','agentpeerchat']){
  const profiles=join(homedir(),'.config',name);let entries=[];
  try{entries=await readdir(profiles);}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const id of entries.filter(id=>/^agt_[A-Za-z0-9_]+$/.test(id))){const path=join(profiles,id,'config.json');try{await access(path);found.set(id,path);}catch{}}
 }
 if(found.size===1)process.env.AGENTPEERCHAT_CONFIG=[...found.values()][0];
 else if(found.size>1)throw new Error('Multiple agent profiles found. Select one with --profile AGENT_ID.');
}
if(command==='skill'){
 const skill=await readFile(skillPath,'utf8');
 if(args.length===1){console.log(skill);process.exit(0);}
 if(args[1]!=='--install')throw Error('Use agentpeerchat skill --install [DIRECTORY].');
 const target=args[2]&&!args[2].startsWith('--')?args[2]:undefined;
 const installArgs=args.slice(target?3:2);await selectProfile();
 const runtime=await detectRuntime();
 const installed=await installSkill({source:skillPath,target,runtime});
 console.log('AgentPeerChat skill installed: '+join(installed,'SKILL.md'));
 if(installArgs.includes('--listen')){
  console.log(JSON.stringify(await automation('listen',['install',...installArgs.filter(x=>x!=='--listen')],{cli:resolve(process.argv[1])}),null,2));
 }else if(installArgs.length)throw Error('Extra skill options require --listen.');
 else if(process.env.AGENTPEERCHAT_CONFIG)console.log(JSON.stringify(await onboard({profile:process.env.AGENTPEERCHAT_CONFIG,cli:resolve(process.argv[1]),skillSource:skillPath}),null,2));
 else console.log('Skill installed. Use the instance invitation to join; receiving starts automatically after connecting.');
 process.exit(0);
}
if(command!=='join')await selectProfile();
if(command==='setup'){
 if(!process.env.AGENTPEERCHAT_CONFIG)throw Error('Join your instance first.');
 const options=setupOptions(args.slice(1));
 console.log(JSON.stringify(await onboard({profile:process.env.AGENTPEERCHAT_CONFIG,cli:resolve(process.argv[1]),skillSource:skillPath,...options}),null,2));process.exit(0);
}
if(['listen','schedule'].includes(command)){try{console.log(JSON.stringify(await automation(command,args.slice(1),{cli:resolve(process.argv[1])}),null,2));}catch(e){console.error(e.message);process.exitCode=1;}process.exit(process.exitCode||0);}
const joinArgs=command==='join'?(args.includes('--invite')?args.slice(1):['--from-stdin',...args.slice(1)]):args;
const child=spawn(process.execPath,[command==='join'?join(sources,'install.mjs'):clientPath,...joinArgs],{stdio:'inherit',env:{...process.env,AGENTPEERCHAT_BUNDLED_DIRECTORY:sources,AGENTPEERCHAT_BUNDLED_CLIENT:clientPath,AGENTPEERCHAT_EXECUTABLE:resolve(process.argv[1])}});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;});
