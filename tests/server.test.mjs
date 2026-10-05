import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { createApplication } from '../server/app.mjs';
const secret = 'server-test-secret-with-32-characters';
const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const worker = (await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))).default;
const options = { worker, setupSecret: secret, publicUrl: 'https://private.example', assetsDirectory: resolve('public'), migrationsDirectory: resolve('migrations') };
test('server persists messages, acknowledgments and keys across restart; HTTP protects cookies, bodies and assets', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'agentpenpal server '));
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
  await app.close(); app = undefined; await start();
  assert.equal((await call('/api/v1/status')).data.initialized, true);
  assert.equal((await call('/api/v1/me', { key })).status, 200);
  assert.equal((await call(`/api/v1/messages/${sent.data.message.id}`, { key })).data.message.content, 'Survives a restart');
  const inbox = await call('/api/v1/inbox?include_acked=0', { key: agentKey }); assert.equal(inbox.status, 200); assert.ok(!inbox.data.items.some(message => message.id === sent.data.message.id));
  const history = await call(`/api/v1/messages/${sent.data.message.id}`, { key }); assert.ok(history.data.receipts.find(receipt => receipt.recipient_id === agent.data.principal.id).acked_at);
  const replay = await call('/api/v1/messages', { method: 'POST', key, body: { to: [agent.data.principal.id], type: 'text', content: 'Survives a restart' }, headers: { 'Idempotency-Key': 'persistent-message' } }); assert.equal(replay.status, 200); assert.equal(replay.data.message.id, sent.data.message.id);
  assert.equal((await app.database.prepare('SELECT COUNT(*) AS n FROM agentgram_migrations').first()).n, 4);
 } finally { if (app) await app.close(); await rm(directory, { recursive: true, force: true }); }
});
test('server refuses weak setup secrets and public HTTP origins before creating storage', async () => {
 await assert.rejects(createApplication({ ...options, databasePath: '/unused', setupSecret: '' }), /24/);
 await assert.rejects(createApplication({ ...options, databasePath: '/unused', publicUrl: 'http://public.example' }), /HTTPS/);
});

test('real installer waits for pairing approval then saves credentials and delivers its connection message', {timeout:20000}, async t => {
 const {spawn}=await import('node:child_process');const {readFile}=await import('node:fs/promises');
 const directory=await mkdtemp(join(tmpdir(),'agentpenpal-pair-install-'));
 const app=await createApplication({...options,databasePath:join(directory,'store.sqlite')});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${app.server.address().port}`;
 const call=async(path,key,body)=>{const r=await fetch(url+'/api/v1'+path,{method:body?'POST':'GET',headers:{...(key?{Authorization:'Bearer '+key}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,path+' '+r.status);return r.json();};
 const owner=await call('/setup',null,{name:'Owner',setup_secret:secret});
 const issued=await call('/pairings',owner.access_key,{name:'Installer Agent'});
 const profile=join(directory,'.config','agentpenpal',issued.principal.id,'config.json');
 const child=spawn(process.execPath,['scripts/install.mjs','--from-stdin'],{env:{...process.env,HOME:directory,AGENTPENPAL_CONFIG:profile,AGENTPENPAL_TOKEN:'',AGENTPENPAL_URL:'',NO_PROXY:'127.0.0.1,localhost',no_proxy:'127.0.0.1,localhost'}});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 let out='',err='',approval;
 child.stdout.on('data',bytes=>{out+=bytes;const code=/Pairing code: ([A-F0-9]{4}-[A-F0-9]{4})/.exec(out)?.[1];if(code&&!approval)approval=call(`/pairings/${issued.pairing.id}/approve`,owner.access_key,{verification_code:code});});child.stderr.on('data',bytes=>err+=bytes);
 child.stdin.end(JSON.stringify({url,principal_id:issued.principal.id,pairing:issued.pairing,owner_id:owner.principal.id}));
 const result=await new Promise(resolve=>child.on('close',resolve));await approval;assert.equal(result,0,err);
 const saved=JSON.parse(await readFile(profile,'utf8'));assert.equal(saved.pairing,undefined);assert.equal((await stat(profile)).mode&0o777,0o600);assert.ok(!out.includes(saved.token));
 assert.equal((await call('/me',saved.token)).principal.id,issued.principal.id);
 assert.ok((await call('/inbox',owner.access_key)).items.some(m=>m.sender_id===issued.principal.id));
 await assert.rejects(stat(join(directory,'.config','agentpenpal',issued.principal.id,'pending-pairing.json')));
});
