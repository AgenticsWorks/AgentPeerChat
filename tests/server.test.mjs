import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { createApplication } from '../server/app.mjs';
import { automation } from '../scripts/automation.mjs';
const secret = 'server-test-secret-with-32-characters';
const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const worker = (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
const options = { worker, setupSecret: secret, publicUrl: 'https://private.example', assetsDirectory: resolve('public'), migrationsDirectory: resolve('migrations') };
test('server persists messages, acknowledgments and keys across restart; HTTP protects cookies, bodies and assets', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'agentpeerchat server '));
 let app;
 async function start() { app = await createApplication({ ...options, databasePath: join(directory, 'store.sqlite') }); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); }
 async function call(path, { method = 'GET', key, body, headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, data: await response.json() };
 }
 try {
  await start();
  assert.equal((await stat(join(directory, 'store.sqlite'))).mode & 0o777, 0o600);
  const owner = await call('/api/v1/setup', { method: 'POST', body: { name: 'Owner', setup_secret: secret } }); assert.equal(owner.status, 201);
  const key = owner.data.access_key;
  const agent = await call('/api/v1/agents', { method: 'POST', key, body: { name: 'Agent' } }); assert.equal(agent.status, 201);
  const sent = await call('/api/v1/messages', { method: 'POST', key, body: { to: [agent.data.principal.id], type: 'text', content: 'Survives a restart' }, headers: { 'Idempotency-Key': 'persistent-message' } }); assert.equal(sent.status, 201);
  const agentKey = agent.data.token.token;
  assert.equal((await call(`/api/v1/messages/${sent.data.message.id}/ack`, { method: 'POST', key: agentKey })).status, 200);
  const session = await call('/api/v1/session', { method: 'POST', body: { access_key: key }, headers: { Origin: options.publicUrl } }); assert.equal(session.status, 200);
  assert.match(session.headers.get('set-cookie'), /Secure/); assert.match(session.headers.get('set-cookie'), /HttpOnly/);
  const forbidden = await call('/api/v1/agents', { method: 'POST', body: { name: 'CSRF' }, headers: { Cookie: session.headers.get('set-cookie').split(';')[0], Origin: 'https://evil.example', 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' } }); assert.equal(forbidden.status, 403);
  const oversized = await call('/api/v1/messages', { method: 'POST', key, body: { content: 'a'.repeat(70000) } }); assert.equal(oversized.status, 413);
  for (const path of ['/.server.env', '/store.sqlite', '/server/start.mjs', '/%2e%2e/.server.env']) assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}${path}`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}/`)).status, 200);
  for (const name of ['dots', 'grok', 'muse']) {
   const avatar = await fetch(`http://127.0.0.1:${app.server.address().port}/avatars/${name}.svg`);
   assert.equal(avatar.status, 200, `Preset ${name} must be served by the SQLite host`);
   assert.match(avatar.headers.get('content-type'), /^image\/svg\+xml/);
   assert.match(await avatar.text(), /<svg\b/);
  }
  for (const path of ['/avatars/unknown.svg', '/avatars/.server.env', '/avatars/../server/start.mjs'])
   assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}${path}`)).status, 404);
  await app.close(); app = undefined; await start();
  assert.equal((await call('/api/v1/status')).data.initialized, true);
  assert.equal((await call('/api/v1/me', { key })).status, 200);
  assert.equal((await call(`/api/v1/messages/${sent.data.message.id}`, { key })).data.message.content, 'Survives a restart');
  const inbox = await call('/api/v1/inbox?include_acked=0', { key: agentKey }); assert.equal(inbox.status, 200); assert.ok(!inbox.data.items.some(message => message.id === sent.data.message.id));
  const history = await call(`/api/v1/messages/${sent.data.message.id}`, { key }); assert.ok(history.data.receipts.find(receipt => receipt.recipient_id === agent.data.principal.id).acked_at);
  const replay = await call('/api/v1/messages', { method: 'POST', key, body: { to: [agent.data.principal.id], type: 'text', content: 'Survives a restart' }, headers: { 'Idempotency-Key': 'persistent-message' } }); assert.equal(replay.status, 200); assert.equal(replay.data.message.id, sent.data.message.id);
  assert.equal((await app.database.prepare('SELECT COUNT(*) AS n FROM agentgram_migrations').first()).n, (await readdir(options.migrationsDirectory)).filter(file=>file.endsWith('.sql')).length);
 } finally { if (app) await app.close(); await rm(directory, { recursive: true, force: true }); }
});
test('server refuses weak setup secrets and public HTTP origins before creating storage', async () => {
 await assert.rejects(createApplication({ ...options, databasePath: '/unused', setupSecret: '' }), /24/);
 await assert.rejects(createApplication({ ...options, databasePath: '/unused', publicUrl: 'http://public.example' }), /HTTPS/);
});

for(const installMode of ['download','source','source-workbuddy','bundled-workbuddy','source-codex','bundled-codex']) test(`${installMode} installer waits for pairing approval and saves a runnable private client`, {timeout:20000}, async t => {
 const {spawn}=await import('node:child_process');const {readFile}=await import('node:fs/promises');
 const directory=await mkdtemp(join(tmpdir(),'agentpeerchat-pair-install-'));
 const app=await createApplication({...options,databasePath:join(directory,'store.sqlite')});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 let profile;
 t.after(async()=>{try{if(profile&&await stat(profile).then(()=>true,()=>false))await automation('listen',['remove'],{cli:resolve('cli/agentpeerchat.mjs'),env:{...process.env,AGENTPEERCHAT_CONFIG:profile}});}finally{await app.close();await rm(directory,{recursive:true,force:true});}});
 const url=`http://127.0.0.1:${app.server.address().port}`;
 const call=async(path,key,body)=>{const r=await fetch(url+'/api/v1'+path,{method:body?'POST':'GET',headers:{...(key?{Authorization:'Bearer '+key}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,path+' '+r.status);return r.json();};
 const owner=await call('/setup',null,{name:'Owner',setup_secret:secret});
 const issued=await call('/pairings',owner.access_key,{name:'Installer Agent'});
 profile=join(directory,'.config','agentpeerchat',issued.principal.id,'config.json');
 const workbuddy=installMode.endsWith('-workbuddy');
 const codex=installMode.endsWith('-codex');
 const command=installMode.startsWith('source')?['cli/agentpeerchat.mjs','join']:installMode.startsWith('bundled')?['dist/cli/agentpeerchat.mjs','join']:['scripts/install.mjs','--from-stdin'];
 const child=spawn(process.execPath,[...command,...(workbuddy?['workbuddy']:codex?['codex']:[])],{env:{...process.env,HOME:directory,WORKBUDDY_CONFIG_DIR:join(directory,'.workbuddy'),CODEX_HOME:join(directory,'.codex'),AGENTPEERCHAT_CODEX_CLI:process.execPath,AGENTPEERCHAT_CONFIG:profile,AGENTPEERCHAT_TOKEN:'',AGENTPEERCHAT_URL:'',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'}});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 let out='',err='',approval;
 child.stdout.on('data',bytes=>{out+=bytes;const code=/Pairing code: ([A-F0-9]{4}-[A-F0-9]{4})/.exec(out)?.[1];if(code&&!approval)approval=call(`/pairings/${issued.pairing.id}/approve`,owner.access_key,{verification_code:code});});child.stderr.on('data',bytes=>err+=bytes);
 child.stdin.end(JSON.stringify({url,principal_id:issued.principal.id,pairing:issued.pairing,owner_id:owner.principal.id}));
 const result=await new Promise(resolve=>child.on('close',resolve));await approval;assert.equal(result,0,err);
 const saved=JSON.parse(await readFile(profile,'utf8'));assert.equal(saved.pairing,undefined);assert.equal((await stat(profile)).mode&0o777,0o600);assert.ok(!out.includes(saved.token));
 assert.equal((await call('/me',saved.token)).principal.id,issued.principal.id);
 if(workbuddy){
  const setup=JSON.parse(await readFile(profile+'.onboarding.json','utf8'));
  assert.equal(setup.runtime,'workbuddy');assert.equal(setup.status,'native_wake_required');
  assert.equal(setup.native_wake.installed,false);assert.equal(setup.native_wake.interval_minutes,30);
  assert.equal(setup.skill_directory,join(directory,'.workbuddy','skills','agentpeerchat'));
  assert.ok(!JSON.stringify(setup).includes(saved.token));
 }
 if(codex){const setup=JSON.parse(await readFile(profile+'.onboarding.json','utf8'));assert.equal(setup.runtime,'codex');assert.equal(setup.status,'receiving_configured');const runner=JSON.parse(await readFile(profile+'.automation/runner.json','utf8'));assert.equal(runner.mode,'native');assert.equal(runner.result_protocol,'codex');}
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const checked=await promisify(execFile)(process.execPath,[join(directory,'.config','agentpeerchat',issued.principal.id,'agentpeerchat.mjs'),'me'],{env:{...process.env,AGENTPEERCHAT_CONFIG:profile,AGENTPEERCHAT_URL:'',AGENTPEERCHAT_TOKEN:'',NODE_USE_ENV_PROXY:'0'}});
 assert.equal(JSON.parse(checked.stdout).principal.id,issued.principal.id);
 assert.ok((await call('/inbox',owner.access_key)).items.some(m=>m.sender_id===issued.principal.id));
 await assert.rejects(stat(join(directory,'.config','agentpeerchat',issued.principal.id,'pending-pairing.json')));
});
