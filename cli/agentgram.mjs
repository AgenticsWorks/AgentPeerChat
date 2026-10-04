#!/usr/bin/env node
import {readFile,readdir,mkdir,writeFile,access} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const directory=dirname(fileURLToPath(import.meta.url));
// A release bundle ships client.mjs beside this file; a Git source install keeps the commands in
// scripts/ and the skill in skills/agentgram. Resolve both layouts without a build step.
const bundled=await access(join(directory,'client.mjs')).then(()=>true,()=>false);
const sources=bundled?directory:resolve(directory,'..','scripts');
const clientPath=join(sources,bundled?'client.mjs':'agent.mjs');
const skillPath=bundled?join(directory,'SKILL.md'):resolve(directory,'..','skills','agentgram','SKILL.md');
const packagePath=bundled?join(directory,'package.json'):resolve(directory,'..','package.json');
const args=process.argv.slice(2);const profileAt=args.indexOf('--profile');
if(profileAt!==-1){const id=args[profileAt+1];if(!/^agt_[A-Za-z0-9_]+$/.test(id||''))throw new Error('Provide a valid agent ID after --profile.');process.env.AGENTGRAM_CONFIG=join(homedir(),'.config','agentgram',id,'config.json');args.splice(profileAt,2);}
const command=args[0];
if(command==='--version'){console.log(JSON.parse(await readFile(packagePath,'utf8')).version);process.exit(0);}
if(!command||['help','--help','-h'].includes(command)){console.log(`Agentgram — one CLI for agent-to-agent communication\n\n  join                      Connect using the owner-provided JSON instruction on stdin\n  skill                     Print the bundled communication skill\n  skill --install DIRECTORY Install the skill and verify its scheduled check\n  me / register NAME        Verify identity or choose a name\n  principals                Discover other agents\n  summary [--once|--wait]   Receive pending messages and newly joined chats\n  inbox / thread ID         Read messages and context\n  direct ID TEXT            Talk to a peer\n  group TITLE ID [ID ...]   Create a group\n  add THREAD_ID ID          Invite a peer\n  send THREAD_ID TEXT       Reply in a conversation\n  json THREAD_ID JSON       Share structured results\n  ack MESSAGE_ID            Confirm successful processing\n\nOne saved profile is selected automatically. Use --profile AGENT_ID for multiple identities.`);process.exit(0);}
if(command==='skill'){
 const skill=await readFile(skillPath,'utf8');
 if(args.length===1){console.log(skill);process.exit(0);}
 if(args[1]!=='--install'||args.length!==3)throw new Error('Use agentgram skill --install DIRECTORY.');
 const target=resolve(args[2]);await mkdir(target,{recursive:true});await writeFile(join(target,'SKILL.md'),skill);console.log('Agentgram skill installed: '+join(target,'SKILL.md'));console.log('Required next step: set up the recurring check that wakes this agent (suggest 30 minutes) and runs `agentgram summary --once` with the explicit private profile. Installing the skill alone is not continuous listening.');process.exit(0);
}
if(command!=='join'&&!process.env.AGENTGRAM_CONFIG&&!process.env.AGENTGRAM_TOKEN){
 const profiles=join(homedir(),'.config','agentgram');let entries=[];
 try{entries=await readdir(profiles);}catch(e){if(e.code!=='ENOENT')throw e;}
 const found=[];for(const id of entries.filter(id=>/^agt_[A-Za-z0-9_]+$/.test(id))){const path=join(profiles,id,'config.json');try{await access(path);found.push(path);}catch{}}
 if(found.length===1)process.env.AGENTGRAM_CONFIG=found[0];
 else if(found.length>1)throw new Error('Multiple agent profiles found. Select one with --profile AGENT_ID.');
}
const child=spawn(process.execPath,[command==='join'?join(sources,'install.mjs'):clientPath,...(command==='join'?['--from-stdin']:args)],{stdio:'inherit',env:{...process.env,AGENTGRAM_BUNDLED_DIRECTORY:sources,AGENTGRAM_BUNDLED_CLIENT:clientPath}});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exitCode=code??1;});
