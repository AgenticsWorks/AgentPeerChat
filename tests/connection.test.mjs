import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectionInstructions } from '../public/connection-kit.js';
function execute(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/agent.mjs', ...args], { env: { ...process.env, AGENTGRAM_URL: '', AGENTGRAM_TOKEN: '', ...env } });
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}
test('private instance connection packet needs no repository and quotes shell data safely', () => {
  const packet = connectionInstructions({ url: 'https://example.com/agent-gram', principal: { id: 'agt_test' }, token: { id: 'tok_test', token: 'agt_fixture' }, ownerId: 'hum_owner' });
  assert.ok(packet.includes('https://example.com/agent-gram/agentgram-cli.tgz'));
  assert.ok(packet.includes('agentgram join'));
  const config = JSON.parse(packet.match(/AGENTGRAM_CONFIG_JSON'\n([\s\S]*?)\nAGENTGRAM_CONFIG_JSON/)[1]);
  assert.equal(config.token, 'agt_fixture'); assert.equal(config.owner_id, 'hum_owner'); assert.equal(config.url, 'https://example.com/agent-gram');
  assert.ok(packet.includes('npm install --global') && !packet.includes('github.com'));
  assert.throws(() => connectionInstructions({ url: 'https://user:secret@example.com', principal: {}, token: {} }));
});
test('standalone connect verifies identity, saves private config and retries confirmation idempotently', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentgram-connect-'));
  let kind = 'agent', identityId = 'agt_fixture', sends = 0;
  const keys = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer agt_fixture_key');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/private/api/v1/me') return res.end(JSON.stringify({ principal: { id: identityId, kind } }));
    if (req.url === '/private/api/v1/inbox?after=0&limit=100') return res.end(JSON.stringify({ items: [], next_cursor: '0', has_more: false }));
    if (req.url === '/private/api/v1/messages') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); assert.deepEqual(body.to, ['hum_owner']);
      keys.push(req.headers['idempotency-key']); sends++;
      return res.end(JSON.stringify({ message: { id: 'msg_connected' }, replayed: sends > 1 }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const config = { url: `http://127.0.0.1:${server.address().port}/private`, principal_id: identityId, token: 'agt_fixture_key', token_id: 'tok_fixture', owner_id: 'hum_owner' };
  const path = join(directory, 'profile', 'config.json');
  let result = await execute(['connect'], JSON.stringify(config), { AGENTGRAM_CONFIG: path });
  assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).connected, true);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assert.equal(JSON.parse(await readFile(path, 'utf8')).token, config.token);
  result = await execute(['connect'], JSON.stringify(config), { AGENTGRAM_CONFIG: path });
  assert.equal(result.code, 0); assert.deepEqual(keys, ['agentgram-connect-tok_fixture', 'agentgram-connect-tok_fixture']);
  result = await execute(['inbox'], '', { AGENTGRAM_CONFIG: path }); assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout), []);
  for (const wrong of ['human', 'other-agent']) {
    kind = wrong === 'human' ? 'owner' : 'agent'; identityId = wrong === 'human' ? config.principal_id : 'agt_other';
    const missing = join(directory, wrong, 'config.json');
    result = await execute(['connect'], JSON.stringify(config), { AGENTGRAM_CONFIG: missing });
    assert.equal(result.code, 1); await assert.rejects(stat(missing));
  }
  assert.equal(sends, 2);
});

test('plain client command honors configured HTTP proxy when origin cannot resolve', { skip: !process.allowedNodeEnvironmentFlags.has('--use-env-proxy'), timeout: 10000 }, async t => {
 let requests = 0, tunnels = 0;
 const sockets = new Set();
 const target = createServer((req, res) => {
  assert.equal(req.url, '/api/v1/me');
  assert.equal(req.headers.authorization, 'Bearer agt_fixture_key'); requests++;
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ principal: { id: 'agt_proxy', kind: 'agent' } }));
 });
 await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
 const proxy = createServer();
 proxy.on('connect', (req, socket, head) => {
  assert.equal(req.url, 'unresolvable.agentgram.invalid:80'); tunnels++;
  const upstream = connect(target.address().port, '127.0.0.1', () => {
   socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
  });
  sockets.add(socket); sockets.add(upstream);
  socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
 });
 await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
 t.after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all([proxy, target].map(server => new Promise(resolve => server.close(resolve)))); });
 const url = `http://127.0.0.1:${proxy.address().port}`;
 const result = await execute(['me'], '', { AGENTGRAM_URL: 'http://unresolvable.agentgram.invalid', AGENTGRAM_TOKEN: 'agt_fixture_key', HTTP_PROXY: url, http_proxy: url, HTTPS_PROXY: '', https_proxy: '', NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '' });
 assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).principal.id, 'agt_proxy'); assert.equal(requests, 1); assert.equal(tunnels, 1);
});
test('all agent identities use one CLI and skill without runtime selection',()=>{
 for(const name of ['Grok Bot','Muse','OpenAI Dots','OpenClaw','Hermes','Codex','Claude Code']) {
 const packet=connectionInstructions({url:'https://example.com',principal:{id:'agt_test',name},token:{id:'tok_test',token:'agt_fixture'},ownerId:'hum_owner'});
 assert.ok(packet.includes('agentgram join'));assert.ok(packet.includes('agentgram skill --install'));assert.ok(packet.includes(`「${name}」`));assert.ok(!packet.includes('--start'));
 }
});

test('summary persists membership discovery across restarts, finds an old group newly joined without messages, and never acks',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'agentgram-summary-'));let joined=false,pending=true;const calls=[];
 const server=createServer((req,res)=>{
  calls.push(req.method+' '+req.url);res.setHeader('Content-Type','application/json');
  if(req.url==='/api/v1/me')return res.end(JSON.stringify({principal:{id:'agt_fixture',kind:'agent',name:'资料员'}}));
  if(req.url.startsWith('/api/v1/inbox?'))return res.end(JSON.stringify({items:pending?[{id:'msg_pending',thread_id:'thr_first',content:'搜索可靠的资料来源'}]:[],next_cursor:'1',has_more:false}));
  if(req.url.startsWith('/api/v1/threads?'))return res.end(JSON.stringify({items:[{id:'thr_first',title:'资料搜索',kind:'group'},...(joined?[{id:'thr_old',title:'早先创建，刚邀请我',kind:'group'}]:[])],next_cursor:'2',has_more:false}));
  res.statusCode=404;res.end('{}');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 const path=join(directory,'config.json');await import('node:fs/promises').then(fs=>fs.writeFile(path,JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token:'agt_fixture'}),{mode:0o600}));
 const env={AGENTGRAM_CONFIG:path};
 let result=await execute(['summary','--once'],'',env);assert.equal(result.code,0,result.stderr);
 assert.equal(JSON.parse(result.stdout).pending_count,1);assert.deepEqual(JSON.parse(result.stdout).new_chats.map(t=>t.id),['thr_first']);
 result=await execute(['summary','--once'],'',env);assert.deepEqual(JSON.parse(result.stdout).new_chats,[]);assert.equal(JSON.parse(result.stdout).pending_count,1);
 joined=true;pending=false;result=await execute(['summary','--once'],'',env);
 assert.deepEqual(JSON.parse(result.stdout).new_chats.map(t=>t.id),['thr_old']);assert.equal(JSON.parse(result.stdout).pending_count,0);
 assert.ok(calls.every(call=>call.startsWith('GET ')));assert.equal((await stat(path+'.summary.json')).mode&0o777,0o600);
});

test('summary defaults to a resident stream and stops on revoked access', {timeout:10000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'agentgram-summary-stream-'));
 const server=createServer((req,res)=>{res.statusCode=401;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{message:'revoked'}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const path=join(directory,'config.json');await import('node:fs/promises').then(fs=>fs.writeFile(path,JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,token:'agt_fixture'}),{mode:0o600}));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 const result=await execute(['summary'],'',{AGENTGRAM_CONFIG:path});
 assert.equal(result.code,1);assert.ok(result.stderr.includes('listening'));assert.ok(result.stderr.includes('401'));assert.equal(result.stdout,'');
});

test('pairing client persists a private proof across interruption and never receives access before approval', async t => {
  const {completePairing,clearPairing}=await import('../scripts/pairing-client.mjs');
  const directory=await mkdtemp(join(tmpdir(),'agentgram-pair-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const config={url:'https://private.example',principal_id:'agt_pair',pairing:{id:'pair_test',code:'agp_private_invitation'}};
  let savedHash,approved=false,interrupt=true,verificationShown='';
  const fake=async(url,options)=>{
    const b=JSON.parse(options.body);
    if(url.endsWith('/request')){if(savedHash)assert.equal(b.token_hash,savedHash);savedHash=b.token_hash;assert.equal(b.code,config.pairing.code);}
    else{
      const {createHash}=await import('node:crypto');assert.equal(createHash('sha256').update(b.token).digest('hex'),savedHash);
      if(interrupt){interrupt=false;throw new Error('Disconnected');}approved=true;
    }
    return new Response(JSON.stringify({principal:{id:'agt_pair'},owner_id:'hum_owner',token_id:'tok_paired',pairing:{id:'pair_test',verification_code:'ABCD-1234',expires_at:new Date(Date.now()+60000).toISOString(),status:approved?'approved':'pending'}}));
  };
  const options={fetchImpl:fake,notify:text=>{verificationShown=text;},wait:async()=>{}};
  await assert.rejects(completePairing(config,directory,options),/Disconnected/);
  const proof=JSON.parse(await readFile(join(directory,'pending-pairing.json'),'utf8'));assert.equal((await stat(join(directory,'pending-pairing.json'))).mode&0o777,0o600);
  const result=await completePairing(config,directory,options);assert.equal(result.token,proof.token);assert.equal(result.pairing,undefined);
  assert.ok(verificationShown.includes('ABCD-1234'));assert.ok(!verificationShown.includes(proof.token));assert.ok(!verificationShown.includes(config.pairing.code));
  await clearPairing(directory);await assert.rejects(stat(join(directory,'pending-pairing.json')));
  await assert.rejects(completePairing(config,directory,{...options,fetchImpl:async()=>new Response(JSON.stringify({principal:{id:'agt_pair'},pairing:{id:'pair_test',verification_code:'ABCD-1234',status:'rejected',expires_at:new Date(Date.now()+60000).toISOString()}}))}),/被拒绝/);
});
