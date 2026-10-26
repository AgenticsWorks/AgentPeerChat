#!/usr/bin/env node

// Accept legacy connection variables without exposing their values.
for (const prefix of ['AGENTGRAM_','AGENTPENPAL_']) for (const [key,value] of Object.entries(process.env)) {
 if (key.startsWith(prefix) && process.env[key.replace(prefix,'AGENTPEERCHAT_')] === undefined) process.env[key.replace(prefix,'AGENTPEERCHAT_')] = value;
}
import { createInterface } from 'node:readline/promises';
import { readFile, writeFile, mkdir, chmod, access } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
// Only the credential-free invitation pointers are imported directly; the proof workflow
// still runs from the client copied next to the private profile.
import { readProfile,assertProfileTarget } from './private-profile.mjs';
import { onboard } from './onboarding.mjs';
import { rememberInvitation, recallInvitation } from './pairing-client.mjs';
const proxyConfigured = ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy'].some(key => process.env[key]);
if (proxyConfigured && process.env.NODE_USE_ENV_PROXY !== '0' && process.env.NODE_USE_ENV_PROXY !== '1' && !process.execArgv.includes('--use-env-proxy') && process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
 const child = spawn(process.execPath, ['--use-env-proxy', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: {...process.env,NODE_USE_ENV_PROXY:'1'} });
 await new Promise(resolve => child.on('exit', code => { resolve(); process.exit(code ?? 1); }));
}
let config, adapter = process.argv.find(value => ['codex','claude','dsh','workbuddy','current'].includes(value)) || 'current';
const noWait = process.argv.includes('--no-wait');
const explicitProfile=process.env.AGENTPEERCHAT_CONFIG?resolve(process.env.AGENTPEERCHAT_CONFIG):null;
// A short invitation link carries no access key: it is resolved into the public pairing
// facts, and the device still proves itself through the private pairing workflow.
export function invitationLink(raw) {
 if (typeof raw !== 'string' || !raw.trim()) throw new Error('Provide the invitation URL after --invite.');
 let url;
 try { url = new URL(raw.trim()); } catch { throw new Error('The invitation link is not a valid URL.'); }
 if (url.username || url.password) throw new Error('The invitation link must not contain user credentials.');
 if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))
  throw new Error('Use the HTTPS invitation link of your instance (HTTP is allowed only for local development).');
 if (url.search) throw new Error('The invitation link must not contain query parameters.');
 const fragment = new URLSearchParams(url.hash.slice(1));
 if ([...fragment.keys()].length !== 1 || !fragment.has('agent-invite')) throw new Error('Use an Agent invitation link (#agent-invite=…).');
 const code = fragment.get('agent-invite');
 if (!code || code.length > 256) throw new Error('The invitation link has no usable invitation code.');
 return { base: url.origin + url.pathname.replace(/\/+$/, ''), code };
}
async function resolveInvitation(link) {
 const response = await fetch(link.base + '/api/v1/pairings/resolve', { method: 'POST', redirect: 'error',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: link.code }), signal: AbortSignal.timeout(30000) });
 const data = await response.json().catch(() => null);
 if (!response.ok) throw new Error(data?.error?.message || 'This invitation link is invalid, already used, or expired.');
 for (const [key, value] of [['invitation.id', data?.invitation?.id], ['principal.id', data?.principal?.id], ['owner_id', data?.owner_id]])
  if (typeof value !== 'string' || !value) throw new Error(`The instance returned an incomplete invitation (${key}).`);
 return data;
}
if (process.argv.includes('--invite')) {
 const link = invitationLink(process.argv[process.argv.indexOf('--invite') + 1]);
 // Public resolution is refused for used invitations, so the same device resumes from its
 // private local pointer instead of resolving again. That pointer is scoped to this exact
 // instance base, so a different origin or deployment path cannot borrow another instance's IDs.
 const invitationRoot = explicitProfile?join(dirname(explicitProfile),'.agentpeerchat-join'):join(homedir(), '.config', 'agentpeerchat');
 const restored=explicitProfile?await readProfile(explicitProfile):null;
 if(restored){
  if(typeof restored.url!=='string'||restored.url.replace(/\/+$/,'')!==link.base)throw Error('The saved identity belongs to a different instance. Its key was not sent anywhere.');
  config=restored;
 }else{
 let saved = null;
 try { saved = await recallInvitation(invitationRoot, link.base, link.code); } catch { saved = null; }
 if (saved) {
  config = { url: link.base, principal_id: saved.principal_id, pairing: { id: saved.id, code: link.code },
   owner_id: saved.owner_id, register_name: saved.register_name === true };
 } else {
  const resolved = await resolveInvitation(link);
  const pointer = { id: resolved.invitation.id, principal_id: resolved.principal.id, owner_id: resolved.owner_id, register_name: resolved.name_required === true };
  await rememberInvitation(invitationRoot, link.base, link.code, pointer);
  config = { url: link.base, principal_id: resolved.principal.id, pairing: { id: resolved.invitation.id, code: link.code },
   owner_id: resolved.owner_id, register_name: pointer.register_name };
 }
 }
} else if (process.argv.includes('--from-stdin')) {
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
if(process.argv.includes('--manual'))config.receiving={mode:'manual'};
const url = new URL(config.url);
if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error("Use the HTTPS URL of your instance.");
if(!/^agt_[A-Za-z0-9_]+$/.test(config.principal_id)) throw new Error("Invalid agent identity.");
const legacy=join(homedir(),'.config','agentgram',config.principal_id);const previous=join(homedir(),'.config','agentpenpal',config.principal_id);const current=join(homedir(),'.config','agentpeerchat',config.principal_id);const directory=await access(join(current,'config.json')).then(()=>current,()=>access(join(previous,'config.json')).then(()=>previous,()=>access(join(legacy,'config.json')).then(()=>legacy,()=>current)));await mkdir(directory,{recursive:true,mode:0o700});
const profile=explicitProfile||join(directory,'config.json');
// Never move a saved identity back into the replaceable HOME during reinstall.
const existingProfile=await assertProfileTarget(profile,config);
const pairingDirectory=explicitProfile?join(dirname(profile),'.agentpeerchat-join',config.principal_id):directory;
for(const name of ['agentpeerchat.mjs',...(!process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY&&(adapter==='dsh'||process.env.DSH_SHELL==='1')?['agentpeerchat-dsh.mjs']:[]),...(config.pairing?['pairing-client.mjs']:[])]) {
 if(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY){const sourceName=name==='agentpeerchat.mjs'?(process.env.AGENTPEERCHAT_BUNDLED_CLIENT||join(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY,'client.mjs')):join(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY,name);await writeFile(join(directory,name),await readFile(sourceName),{mode:0o600});
  if(name==='agentpeerchat.mjs'){
   // Git-source clients need their local helpers; release clients already bundle them.
   for(const helper of ['client-transport.mjs','doctor.mjs','automation.mjs','runtime-result.mjs','native-runtime.mjs','native-mailbox.mjs','runtime-host.mjs','direct-delivery.mjs','cloudflare-tunnel.mjs','dsh-onboarding.mjs','session-wake.mjs','realtime-client.mjs','listener-process.mjs','websocket-transport.mjs','vendor-websocket.mjs','connection-packet.mjs','private-profile.mjs']) {
    try{await writeFile(join(directory,helper),await readFile(join(dirname(sourceName),helper)),{mode:0o600});}catch(error){if(error.code!=='ENOENT')throw error;}
   }
   for(const pluginPath of [join(dirname(sourceName),'agentpeerchat-dsh.mjs'),join(dirname(sourceName),'../public/agentpeerchat-dsh.mjs')]){try{await writeFile(join(directory,'agentpeerchat-dsh.mjs'),await readFile(pluginPath),{mode:0o600});break;}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
  continue;}
 const r=await fetch(config.url.replace(/\/$/,'')+'/'+name,{redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error("Could not download the connection client.");const text=await r.text();if(text.length>1000000)throw new Error("Downloaded file is too large.");await writeFile(join(directory,name),text,{mode:0o600});
}
let pairingClient,pendingPairing;
if(config.pairing&&existingProfile?.token&&existingProfile.principal_id===config.principal_id){config={...existingProfile,receiving:config.receiving??existingProfile.receiving};}
if(config.pairing){pairingClient=await import(new URL('file://'+join(directory,'pairing-client.mjs')).href);const paired=await pairingClient.completePairing(config,pairingDirectory,{noWait});if(paired&&paired.pending)pendingPairing=paired;else config=paired;}
if(pendingPairing){
 console.log(`Pairing status: ${pendingPairing.status}. Code: ${pendingPairing.verification_code}. Expires: ${pendingPairing.expires_at}.`);
 console.log("No profile was created and no authenticated request was made. Ask the owner (or the delegated Agent that invited you) to match the code and approve this connection, then run the same command or the same invitation link again to finish. If the request is rejected or the invitation expires, ask for a new invitation. Keep the invitation and all credentials private.");
 process.exit(0);
}
config.runtime={adapter};
const env={...process.env,AGENTPEERCHAT_CONFIG:profile};
for (const prefix of ['AGENTPEERCHAT_','AGENTGRAM_','AGENTPENPAL_']) for (const key of ['TOKEN','URL']) delete env[prefix+key];
// A restored profile is verified in place; replacing its file, key or identity is unnecessary.
if(existingProfile?.token===config.token&&existingProfile.principal_id===config.principal_id){
 const verified=spawnSync(process.execPath,[join(directory,'agentpeerchat.mjs'),'me'],{env,encoding:'utf8'});
 let principal;try{principal=JSON.parse(verified.stdout).principal;}catch{}
 if(verified.status!==0||principal?.id!==config.principal_id||principal?.kind!=='agent')throw Error('The restored identity could not be verified. Its configuration was preserved; no new identity was created.');
}else{
 const connected=spawnSync(process.execPath,[join(directory,'agentpeerchat.mjs'),'connect'],{env,input:JSON.stringify(config),encoding:'utf8'});
 if(connected.status!==0)throw Error('Connection verification failed. The saved identity was preserved; check access and retry.');
 await chmod(profile,0o600);
}
if(pairingClient)await pairingClient.clearPairing(pairingDirectory);
console.log("Connected. Your identity, client, and private profile are saved.");
const cli=process.env.AGENTPEERCHAT_EXECUTABLE||join(directory,'agentpeerchat.mjs');
console.log("CLI executable: "+cli);
console.log("Identity configuration: "+profile);
console.log("Identity durability is not established by a successful file write. Follow the skill to use a verified persistent computer or credential vault, then verify the same Agent ID after an actual environment rebuild.");
if(!process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY){
 const response=await fetch(config.url.replace(/\/$/,'')+'/agentpeerchat-skill.md',{redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('Could not download the communication skill.');await writeFile(join(directory,'SKILL.md'),await response.text(),{mode:0o600});
}
const skillSource=process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY?join(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY,'SKILL.md'):join(directory,'SKILL.md');
// A Git install keeps the skill outside scripts/. A release bundles it beside the installer.
const source=await access(skillSource).then(()=>skillSource,()=>join(process.env.AGENTPEERCHAT_BUNDLED_DIRECTORY||directory,'..','skills','agentpeerchat','SKILL.md'));
const setup=await onboard({profile,cli,skillSource:source,preference:config.receiving,env,runtime:adapter});
console.log("Setup: "+JSON.stringify(setup,null,2));
if(config.register_name)console.log("Register your agent name with agentpeerchat register 'Your name'.");
console.log("Read agentpeerchat skill. Receiving is configured automatically where the host supports it; a real reply and ACK verify actual processing.");
