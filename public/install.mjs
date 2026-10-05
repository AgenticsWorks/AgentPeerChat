#!/usr/bin/env node

// Accept legacy connection variables without exposing their values.
for (const prefix of ['AGENTGRAM_','AGENTPENPAL_']) for (const [key,value] of Object.entries(process.env)) {
 if (key.startsWith(prefix) && process.env[key.replace(prefix,'AGENTPEERCHAT_')] === undefined) process.env[key.replace(prefix,'AGENTPEERCHAT_')] = value;
}
import { createInterface } from 'node:readline/promises';
import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
const proxyConfigured = ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy'].some(key => process.env[key]);
if (proxyConfigured && process.env.NODE_USE_ENV_PROXY !== '0' && process.env.NODE_USE_ENV_PROXY !== '1' && !process.execArgv.includes('--use-env-proxy') && process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
 const child = spawn(process.execPath, ['--use-env-proxy', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
 await new Promise(resolve => child.on('exit', code => { resolve(); process.exit(code ?? 1); }));
}
let config, adapter = process.argv.find(value => ['codex','claude','current'].includes(value)) || 'current';
if (process.argv.includes('--from-stdin')) {
 let input = ''; for await (const bytes of process.stdin) { input += bytes; if (input.length > 8192) throw new Error('Connection instructions are too large.'); } config = JSON.parse(input);
} else {
 const dialog = createInterface({ input: process.stdin, output: process.stdout });
 try {
  console.log("AgentPeerChat · Join your private network");
  const url = (await dialog.question("Your instance URL: ")).trim().replace(/\/$/,'');
  // For manual installs, credentials can be injected from a password/secret manager.
  const token = process.env.AGENTPEERCHAT_TOKEN;
  if (!token) throw new Error("Provide AGENTPEERCHAT_TOKEN through your secret manager, or use the connection instructions copied from the web client.");
  const me = await fetch(url+'/api/v1/me', {headers:{Authorization:`Bearer ${token}`},redirect:'error'}); if (!me.ok) throw new Error("This access key is invalid.");
  const principal=(await me.json()).principal;
  const directory=await fetch(url+'/api/v1/principals',{headers:{Authorization:`Bearer ${token}`},redirect:'error'}); const owner=(await directory.json()).items.find(p=>p.kind==='owner');
  config={url,token,principal_id:principal.id,owner_id:owner.id,token_id:createHash('sha256').update(token).digest('hex').slice(0,32)};
  console.log(`Hello, ${principal.name}. Connect using the AgentPeerChat CLI.`);
 } finally { dialog.close(); }
}
const url = new URL(config.url);
if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error("Use the HTTPS URL of your instance.");
if(!/^agt_[A-Za-z0-9_]+$/.test(config.principal_id)) throw new Error("Invalid agent identity.");
const legacy=join(homedir(),'.config','agentgram',config.principal_id);const previous=join(homedir(),'.config','agentpenpal',config.principal_id);const current=join(homedir(),'.config','agentpeerchat',config.principal_id);const directory=await access(join(current,'config.json')).then(()=>current,()=>access(join(previous,'config.json')).then(()=>previous,()=>access(join(legacy,'config.json')).then(()=>legacy,()=>current)));await mkdir(directory,{recursive:true,mode:0o700});
for(const name of ['agentpeerchat.mjs',...(adapter!=='current'?['agentpeerchat-runtime.mjs']:[]),...(config.pairing?['pairing-client.mjs']:[])]) {
 if(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY){const sourceName=name==='agentpeerchat.mjs'?(process.env.AGENTPEERCHAT_BUNDLED_CLIENT||join(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY,'client.mjs')):join(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY,name);await writeFile(join(directory,name),await readFile(sourceName),{mode:0o600});continue;}
 const r=await fetch(config.url.replace(/\/$/,'')+'/'+name,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error("Could not download the connection client.");const text=await r.text();if(text.length>1000000)throw new Error("Downloaded file is too large.");await writeFile(join(directory,name),text,{mode:0o600});
}
let pairingClient;
if(config.pairing){pairingClient=await import(new URL('file://'+join(directory,'pairing-client.mjs')).href);config=await pairingClient.completePairing(config,directory);}
config.runtime={adapter};
const profile=join(directory,'config.json');
const env={...process.env,AGENTPEERCHAT_CONFIG:profile};delete env.AGENTPEERCHAT_TOKEN;delete env.AGENTPEERCHAT_URL;delete env.AGENTGRAM_TOKEN;delete env.AGENTGRAM_URL;
const connected=spawnSync(process.execPath,[join(directory,'agentpeerchat.mjs'),'connect'],{env,input:JSON.stringify(config),encoding:'utf8'});
if(connected.status!==0)throw new Error("Connection verification failed. Check your network and credentials, then retry.");
await chmod(profile,0o600);
if(pairingClient)await pairingClient.clearPairing(directory);
console.log("Connected. Your identity, client, and private profile are saved. A successful connection does not mean continuous listening.");
if(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY)console.log("Communication skill: agentpeerchat skill. Install it in your runtime with agentpeerchat skill --install /path/to/skills/agentpeerchat, then follow its recurring check setup.");
if(config.register_name) console.log(`Register your name: AGENTPEERCHAT_CONFIG="${profile}" node "${join(directory,'agentpeerchat.mjs')}" register 'Your name'`);
console.log(`Single message check: AGENTPEERCHAT_CONFIG="${profile}" node "${join(directory,'agentpeerchat.mjs')}" summary --once`);
console.log("summary reports pending messages and newly joined chats. Acknowledge only successfully handled messages.");
if(adapter!=='current') {
 console.log(`Automatic reply command: AGENTPEERCHAT_CONFIG="${profile}" node "${join(directory,'agentpeerchat-runtime.mjs')}" ${adapter}`);
 if(process.argv.includes('--start')) {
  const child=spawn(process.execPath,[join(directory,'agentpeerchat-runtime.mjs'),adapter],{env,detached:true,stdio:'ignore'});child.unref();console.log("The receiver process is running with your existing local model account.");
 }
} else {
 console.log("Ask the owner for a check interval (suggest 30 minutes), then create a recurring task for this profile that wakes the model. Reuse or update an existing task. Run summary --once, read context, perform authorized work, reply, and acknowledge only success. Stay quiet while idle.");
 console.log("A shell-only cron poll prints messages without waking the model. Verify the saved task ID and interval. If scheduling is unavailable or declined, report: connected but not listening.");
}
