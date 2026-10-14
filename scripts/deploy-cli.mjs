
// Accept legacy connection variables without exposing their values.
for (const prefix of ['AGENTGRAM_','AGENTPENPAL_']) for (const [key,value] of Object.entries(process.env)) {
 if (key.startsWith(prefix) && process.env[key.replace(prefix,'AGENTPEERCHAT_')] === undefined) process.env[key.replace(prefix,'AGENTPEERCHAT_')] = value;
}
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { initializeOwner } from './owner-init.mjs';
const useProxy=['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy'].some(name=>process.env[name]);
if(useProxy&&process.env.NODE_USE_ENV_PROXY!=='0'&&process.env.NODE_USE_ENV_PROXY!=='1'&&!process.execArgv.includes('--use-env-proxy')&&process.allowedNodeEnvironmentFlags.has('--use-env-proxy')){
 const env={...process.env,NO_PROXY:[process.env.NO_PROXY,'127.0.0.1','localhost','[::1]'].filter(Boolean).join(',')};
 const child=spawnSync(process.execPath,['--use-env-proxy',...process.execArgv,...process.argv.slice(1)],{stdio:'inherit',env});process.exit(child.status??1);
}
function wrangler(...args) {
  const capture=args[0]==='deploy';
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { stdio: capture?['inherit','pipe','inherit']:'inherit',encoding:'utf8' });
  if(capture&&result.stdout)process.stdout.write(result.stdout);
  if (result.status !== 0) process.exit(result.status ?? 1);
  return result.stdout||'';
}
const ownerAt=process.argv.indexOf('--owner');
const ownerName=ownerAt===-1?null:process.argv[ownerAt+1];
if(ownerAt!==-1&&(!ownerName||ownerName.startsWith('--')||!ownerName.trim()||ownerName.length>80))throw new Error('Provide a display name of 1..80 characters after --owner.');
let config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
let database = config.d1_databases.find(db => db.binding === 'DB');
if (!database) throw new Error('DB binding is missing from wrangler.jsonc.');
console.log('Deploying AgentPeerChat into the Cloudflare account authenticated by Wrangler.');
await mkdir('.wrangler', { recursive: true });
const path = '.wrangler/deployment-secrets.json';
let secrets;
try { secrets = JSON.parse(await readFile(path, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; secrets = { SETUP_SECRET: randomBytes(32).toString('hex') }; }
if (process.env.AGENTPEERCHAT_SETUP_SECRET) secrets.SETUP_SECRET = process.env.AGENTPEERCHAT_SETUP_SECRET;
if (typeof secrets.SETUP_SECRET !== 'string' || secrets.SETUP_SECRET.length < 24) throw new Error('SETUP_SECRET must contain at least 24 characters.');
await writeFile(path, JSON.stringify(secrets), { mode: 0o600 });
await chmod(path, 0o600);
if (!database.database_id) {
  wrangler('d1', 'create', database.database_name, '--binding', 'DB', '--update-config');
  config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  database = config.d1_databases.find(db => db.binding === 'DB');
  if (!database?.database_id) throw new Error('D1 was not bound. Set the new database UUID in wrangler.jsonc before retrying.');
}
wrangler('d1', 'migrations', 'apply', 'DB', '--remote');
const deployed=wrangler('deploy', '--secrets-file', path);
if(ownerAt!==-1){
 const name=ownerName;
 const urlAt=process.argv.indexOf('--url'),url=urlAt!==-1?process.argv[urlAt+1]:deployed.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev\b/)?.[0];
 if(!url)throw new Error('Could not identify the deployed URL. Provide --url with your own instance URL.');
 const result=await initializeOwner({url,name,setupSecret:secrets.SETUP_SECRET,directory:'.wrangler'});
 console.log(result.requires_existing_login?'This instance already has an owner. Sign in with the existing owner key.':'Owner is ready. The private sign-in link is saved in '+result.file+'. Give it only to the owner; opening it completes browser sign-in without a setup form.');
}else console.log('Open the workers.dev URL above. Your setup secret is saved locally in .wrangler/deployment-secrets.json; use it once to create the owner. Agent-assisted deploys can use --owner NAME to finish initialization automatically.');
