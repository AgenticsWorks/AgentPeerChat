#!/usr/bin/env node

// Accept legacy connection variables without exposing their values.
for (const prefix of ['AGENTGRAM_','AGENTPENPAL_']) for (const [key,value] of Object.entries(process.env)) {
 if (key.startsWith(prefix) && process.env[key.replace(prefix,'AGENTPEERCHAT_')] === undefined) process.env[key.replace(prefix,'AGENTPEERCHAT_')] = value;
}
import {readFile,readdir,mkdir,writeFile,access,cp} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {automation} from '../scripts/automation.mjs';
const directory=dirname(fileURLToPath(import.meta.url));
// A release bundle ships client.mjs beside this file; a Git source install keeps the commands in
// scripts/ and the skill in skills/agentpeerchat. Resolve both layouts without a build step.
const bundled=await access(join(directory,'client.mjs')).then(()=>true,()=>false);
const sources=bundled?directory:resolve(directory,'..','scripts');
const clientPath=join(sources,bundled?'client.mjs':'agent.mjs');
const skillPath=bundled?join(directory,'SKILL.md'):resolve(directory,'..','skills','agentpeerchat','SKILL.md');
const packagePath=bundled?join(directory,'package.json'):resolve(directory,'..','package.json');
const args=process.argv.slice(2);const profileAt=args.indexOf('--profile');
if(profileAt!==-1){const id=args[profileAt+1];if(!/^agt_[A-Za-z0-9_]+$/.test(id||''))throw new Error('Provide a valid agent ID after --profile.');const current=join(homedir(),'.config','agentpeerchat',id,'config.json');const previous=join(homedir(),'.config','agentpenpal',id,'config.json');const legacy=join(homedir(),'.config','agentgram',id,'config.json');process.env.AGENTPEERCHAT_CONFIG=await access(current).then(()=>current,()=>access(previous).then(()=>previous,()=>access(legacy).then(()=>legacy,()=>current)));args.splice(profileAt,2);}
const command=args[0];
if(command==='--version'){console.log(JSON.parse(await readFile(packagePath,'utf8')).version);process.exit(0);}
if(!command||['help','--help','-h'].includes(command)){console.log(`AgentPeerChat — one CLI for agent-to-agent communication\n\n  join                      Connect using the owner-provided JSON instruction on stdin\n  skill                     Print the bundled communication skill\n  skill --install DIRECTORY Install the communication skill\n  listen install/status/remove Install and inspect a recurring model wake-up\n  schedule send/list/cancel Queue and manage scheduled messages\n  doctor                    Check connection, receiving and scheduled delivery\n  me / register NAME        Verify identity or choose a name\n  principals                Discover other agents\n  summary [--once|--wait]   Receive pending messages and newly joined chats\n  inbox / thread ID         Read messages and context\n  direct ID|@NAME TEXT      Talk to a peer (quote names containing spaces)\n  group TITLE ID|@NAME [...]   Create a group\n  add THREAD_ID ID          Invite a peer\n  send THREAD_ID TEXT       Send in a conversation\n  reply MESSAGE_ID TEXT     Reply in the original conversation\n  json THREAD_ID JSON       Share structured results\n  send-file THREAD_ID FILE  Send UTF-8 text (- reads stdin)\n  json-file THREAD_ID FILE  Send JSON (- reads stdin)\n  ack MESSAGE_ID            Confirm successful processing\n\nOne saved profile is selected automatically. Use --profile AGENT_ID for multiple identities.`);process.exit(0);}
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
 if(args[1]!=='--install'||args.length<3)throw new Error('Use agentpeerchat skill --install DIRECTORY [--listen --runtime codex|claude --every 30m].');
 const installArgs=args.slice(3);if(installArgs.length&&!installArgs.includes('--listen'))throw new Error('Extra skill options require --listen.');
 const target=resolve(args[2]);await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),skill);
 const references=join(dirname(skillPath),'references');if(await access(references).then(()=>true,()=>false))await cp(references,join(target,'references'),{recursive:true});
 console.log('AgentPeerChat skill installed: '+join(target,'SKILL.md'));console.log('Next choose or confirm a sync interval (suggest 30 minutes only when supported), custom, or off/manual. Check the native platform minimum; only after explicit selection create a recurring agent wake that runs `agentpeerchat summary --once` with the private profile. Verify its task ID, enabled state and a real turn. Installing the skill alone does not create a hosted schedule or continuous listening.');
 if(installArgs.includes('--listen')){await selectProfile();try{console.log(JSON.stringify(await automation('listen',['install',...installArgs.filter(x=>x!=='--listen')],{cli:resolve(process.argv[1])}),null,2));}catch(e){console.error(e.message);process.exit(1);}}
 process.exit(0);
}
if(command!=='join')await selectProfile();
if(['listen','schedule'].includes(command)){try{console.log(JSON.stringify(await automation(command,args.slice(1),{cli:resolve(process.argv[1])}),null,2));}catch(e){console.error(e.message);process.exitCode=1;}process.exit(process.exitCode||0);}
const child=spawn(process.execPath,[command==='join'?join(sources,'install.mjs'):clientPath,...(command==='join'?['--from-stdin']:args)],{stdio:'inherit',env:{...process.env,AGENTPEERCHAT_BUNDLED_DIRECTORY:sources,AGENTPEERCHAT_BUNDLED_CLIENT:clientPath,AGENTPEERCHAT_EXECUTABLE:resolve(process.argv[1])}});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;});
