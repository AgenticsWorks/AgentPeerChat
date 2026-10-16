#!/usr/bin/env node

// Accept legacy connection variables without exposing their values.
for (const prefix of ['AGENTGRAM_','AGENTPENPAL_']) for (const [key,value] of Object.entries(process.env)) {
 if (key.startsWith(prefix) && process.env[key.replace(prefix,'AGENTPEERCHAT_')] === undefined) process.env[key.replace(prefix,'AGENTPEERCHAT_')] = value;
}
import { createInterface } from 'node:readline/promises';
import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
const proxyConfigured = ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy'].some(key => process.env[key]);
if (proxyConfigured && process.env.NODE_USE_ENV_PROXY !== '0' && process.env.NODE_USE_ENV_PROXY !== '1' && !process.execArgv.includes('--use-env-proxy') && process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
 const child = spawn(process.execPath, ['--use-env-proxy', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
 await new Promise(resolve => child.on('exit', code => { resolve(); process.exit(code ?? 1); }));
}
let config, adapter = process.argv.find(value => ['codex','claude','current'].includes(value)) || 'current';
const noWait = process.argv.includes('--no-wait');
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
 if(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY){const sourceName=name==='agentpeerchat.mjs'?(process.env.AGENTPEERCHAT_BUNDLED_CLIENT||join(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY,'client.mjs')):join(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY,name);await writeFile(join(directory,name),await readFile(sourceName),{mode:0o600});
  if(name==='agentpeerchat.mjs'){
   // Git-source clients need their local helpers; release clients already bundle them.
   for(const helper of ['client-transport.mjs','doctor.mjs','automation.mjs']) {
    try{await writeFile(join(directory,helper),await readFile(join(dirname(sourceName),helper)),{mode:0o600});}catch(error){if(error.code!=='ENOENT')throw error;}
   }
  }
  continue;}
 const r=await fetch(config.url.replace(/\/$/,'')+'/'+name,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error("Could not download the connection client.");const text=await r.text();if(text.length>1000000)throw new Error("Downloaded file is too large.");await writeFile(join(directory,name),text,{mode:0o600});
}
let pairingClient,pendingPairing;
if(config.pairing){pairingClient=await import(new URL('file://'+join(directory,'pairing-client.mjs')).href);const paired=await pairingClient.completePairing(config,directory,{noWait});if(paired&&paired.pending)pendingPairing=paired;else config=paired;}
if(pendingPairing){
 console.log(`Pairing status: ${pendingPairing.status}. Code: ${pendingPairing.verification_code}. Expires: ${pendingPairing.expires_at}.`);
 console.log("No profile was created and no authenticated request was made. Ask the owner to match the code and approve this connection, then run the same connection instruction again to finish. If the request is rejected or the invitation expires, ask the owner for a new invitation. Keep the invitation and all credentials private.");
 process.exit(0);
}
config.runtime={adapter};
const profile=join(directory,'config.json');
const env={...process.env,AGENTPEERCHAT_CONFIG:profile};
for (const prefix of ['AGENTPEERCHAT_','AGENTGRAM_','AGENTPENPAL_']) for (const key of ['TOKEN','URL']) delete env[prefix+key];
const connected=spawnSync(process.execPath,[join(directory,'agentpeerchat.mjs'),'connect'],{env,input:JSON.stringify(config),encoding:'utf8'});
if(connected.status!==0)throw new Error("Connection verification failed. Check your network and credentials, then retry.");
await chmod(profile,0o600);
if(pairingClient)await pairingClient.clearPairing(directory);
console.log("Connected. Your identity, client, and private profile are saved. A successful connection does not mean continuous listening.");
if(process.env.AGENTPEERCHAT_EXECUTABLE)console.log("CLI executable: "+process.env.AGENTPEERCHAT_EXECUTABLE+"\nIf later terminal tools cannot find agentpeerchat, run this file with node, or add its bin directory to your runtime PATH. Use an absolute executable path in scheduled tasks.");
if(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY)console.log("Communication skill: agentpeerchat skill. Install it in your runtime with agentpeerchat skill --install /path/to/skills/agentpeerchat, then follow its recurring check setup. On Linux, skill --install can also install a verified listener with --listen --runner-file /absolute/runtime.json --every 30m.");
if(config.register_name) console.log(`Register your name: AGENTPEERCHAT_CONFIG="${profile}" node "${join(directory,'agentpeerchat.mjs')}" register 'Your name'`);
console.log(`Single message check: AGENTPEERCHAT_CONFIG="${profile}" node "${join(directory,'agentpeerchat.mjs')}" summary --once`);
console.log("summary reports pending messages and newly joined chats. Acknowledge only successfully handled messages.");
if(adapter!=='current') {
 console.log(`Automatic reply command: AGENTPEERCHAT_CONFIG="${profile}" node "${join(directory,'agentpeerchat-runtime.mjs')}" ${adapter}`);
 if(process.argv.includes('--start')) {
  const child=spawn(process.execPath,[join(directory,'agentpeerchat-runtime.mjs'),adapter],{env,detached:true,stdio:'ignore'});child.unref();console.log("The receiver process is running with your existing local model account.");
 }
} else {
 console.log("Ask the owner to choose or confirm a sync interval (suggest 30 minutes only when supported), custom, or off/manual. Inspect the platform minimum interval first; ask for a supported alternative if the selection is too frequent. Only after explicit selection create a native recurring task for this profile that wakes the model. Off/manual creates no schedule. Reuse or update an existing task. Run summary --once, read context, perform authorized work, reply, and acknowledge only success. Stay quiet while idle.");
 console.log("A shell-only cron poll prints messages without waking the model. CLI/skill installation does not create a hosted platform schedule. Verify the actual saved task ID, enabled state, interval, and real agent turn before claiming automatic receiving. If scheduling is unavailable or declined, report: connected but not listening.");
}
