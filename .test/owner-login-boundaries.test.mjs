import{test}from'node:test';import assert from'node:assert/strict';
import{build}from'esbuild';import{SQLiteDatabase}from'../server/sqlite.mjs';import{resolve}from'node:path';
import{readFile,readdir}from'node:fs/promises';
const repo=resolve('.'),origin='https://login-qa.example',setup='synthetic-setup-secret-32-characters';
const compiled=await build({entryPoints:[repo+'/src/index.ts'],bundle:true,format:'esm',platform:'node',write:false});
const worker=(await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'))).default;
async function fixture(t){const db=new SQLiteDatabase(':memory:');t.after(()=>db.close());await db.migrate(repo+'/migrations');
async function call(path,{method='GET',key,cookie,body}={}){const r=await worker.fetch(new Request(origin+'/api/v1'+path,{method,headers:{Origin:origin,...(key?{Authorization:'Bearer '+key}:{}),...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),{DB:db,SETUP_SECRET:setup,ASSETS:{fetch:async()=>new Response('assets')}});return {status:r.status,data:await r.json(),setCookie:r.headers.get('set-cookie'),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
const o=await call('/setup',{method:'POST',body:{setup_secret:setup,name:'QA Owner'}}),owner=o.data.access_key;
const d=await call('/agents',{method:'POST',key:owner,body:{name:'QA Dots'}});assert.equal(d.status,201);const dots=d.data;
const permission=on=>call('/principals/'+dots.principal.id,{method:'PATCH',key:owner,body:{can_help_owner_login:on}});
assert.equal((await permission(true)).status,200);
async function create(){const c=await call('/owner-login-links',{method:'POST',key:dots.token.token,body:{}});return c;}
async function redeem(c){assert.equal(c.status,201);const code=new URL(c.data.login_link.url).hash.slice(1);return call('/owner-login/redeem',{method:'POST',body:{code:new URLSearchParams(code).get('owner-login')}});}
return{db,call,owner,dots,permission,create,redeem};}
test('withdraw and regrant never revive an old delegated owner session',async t=>{const q=await fixture(t),c=await q.create(),r=await q.redeem(c);assert.equal(r.status,200);assert.equal((await q.call('/me',{cookie:r.cookie})).status,200);await q.permission(false);assert.equal((await q.call('/me',{cookie:r.cookie})).status,401);await q.permission(true);assert.equal((await q.call('/me',{cookie:r.cookie})).status,401,'Regrant must not revive a previously withdrawn owner session');});
test('retention cleanup can remove an expired redeemed grant without FK failure',async t=>{const q=await fixture(t),r=await q.redeem(await q.create());assert.equal(r.status,200);await q.db.exec("UPDATE owner_login_grants SET redeemed_at='2000-01-01T00:00:00.000Z';UPDATE tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE owner_login_grant_id IS NOT NULL;");assert.equal((await q.create()).status,201,'Expired delegated session must not permanently block grant cleanup');});

test('issuer key revoked after authentication cannot leave a grant behind',async t=>{const q=await fixture(t),batch=q.db.batch.bind(q.db);let intercepted=false;q.db.batch=async statements=>{if(!intercepted){intercepted=true;await q.db.prepare("UPDATE tokens SET revoked_at='2026-01-01T00:00:00.000Z' WHERE id=?").bind(q.dots.token.id).run();}return batch(statements);};assert.equal((await q.create()).status,401);assert.equal((await q.db.prepare('SELECT COUNT(*) AS n FROM owner_login_grants').first()).n,0);});
test('delegation withdrawn before redemption batch leaves no owner session',async t=>{const q=await fixture(t),c=await q.create(),batch=q.db.batch.bind(q.db);let intercepted=false;q.db.batch=async statements=>{if(!intercepted){intercepted=true;await q.db.prepare('UPDATE principals SET can_help_owner_login=0 WHERE id=?').bind(q.dots.principal.id).run();}return batch(statements);};assert.equal((await q.redeem(c)).status,410);assert.equal((await q.db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE owner_login_grant_id IS NOT NULL').first()).n,0);});

test('remembered browser sessions survive routine link cleanup after several days',async t=>{
 const q=await fixture(t),r=await q.redeem(await q.create());assert.equal(r.status,200);
 await q.db.prepare('UPDATE owner_login_grants SET redeemed_at=? WHERE redeemed_at IS NOT NULL').bind(new Date(Date.now()-3*86400000).toISOString()).run();
 assert.equal((await q.create()).status,201);assert.equal((await q.call('/me',{cookie:r.cookie})).status,200);
});

test('upgrading gives existing active and pending Agents browser access without changing their identity or key',async t=>{
 const db=new SQLiteDatabase(':memory:');t.after(()=>db.close());
 for(const f of (await readdir(repo+'/migrations')).filter(f=>f.endsWith('.sql')&&f<'0013').sort())await db.exec(await readFile(repo+'/migrations/'+f,'utf8'));
 async function call(path,key,body){const r=await worker.fetch(new Request(origin+'/api/v1'+path,{method:body?'POST':'GET',headers:{...(key?{Authorization:'Bearer '+key}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined}),{DB:db,SETUP_SECRET:setup,ASSETS:{fetch:async()=>new Response('assets')}});return {status:r.status,data:await r.json()};}
 const owner=(await call('/setup',null,{name:'Owner',setup_secret:setup})).data.access_key;
 const agent=(await call('/agents',owner,{name:'Existing Grok Bot'})).data;
 const invite=(await call('/pairings',owner,{name:'Pending Muse'})).data;
 await db.prepare("INSERT INTO principals(id,name,kind,active) VALUES ('agt_disabled','Disabled','agent',0)").run();
 const before=await db.prepare('SELECT id,hash,principal_id,expires_at FROM tokens ORDER BY id').all();
 assert.equal((await call('/owner-login-links',agent.token.token,{})).status,403);
 await db.exec(await readFile(repo+'/migrations/0013_paired_browser_access.sql','utf8'));
 assert.deepEqual(await db.prepare('SELECT id,hash,principal_id,expires_at FROM tokens ORDER BY id').all(),before);
 assert.equal((await call('/me',agent.token.token)).data.principal.id,agent.principal.id);
 assert.equal((await call('/owner-login-links',agent.token.token,{})).status,201);
 assert.equal((await db.prepare('SELECT can_help_owner_login AS flag FROM principals WHERE id=?').bind(invite.principal.id).first()).flag,1);
 assert.equal((await db.prepare("SELECT can_help_owner_login AS flag FROM principals WHERE id='agt_disabled'").first()).flag,0);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM pairings').first()).n,1,'no replacement pairing is created');
 await db.prepare('UPDATE principals SET can_help_owner_login=0 WHERE id=?').bind(agent.principal.id).run();
 await call('/agents',owner,{name:'Another trusted Agent'});
 assert.equal((await call('/owner-login-links',agent.token.token,{})).status,403,'an explicit later withdrawal stays off');
});


test('remembered browsers have no fixed expiry and restore the same session after a year', async t=>{
 const q=await fixture(t),r=await q.redeem(await q.create());assert.equal(r.status,200);
 const ancient=new Date(Date.now()-366*86400000).toISOString();
 await q.db.prepare('UPDATE owner_login_grants SET redeemed_at=? WHERE redeemed_at IS NOT NULL').bind(ancient).run();
 await q.db.prepare("UPDATE tokens SET created_at=? WHERE kind='session'").bind(ancient).run();
 assert.equal((await q.create()).status,201,'routine cleanup must keep the remembered browser');
 const before=await q.db.prepare("SELECT id,hash FROM tokens WHERE kind='session'").all();
 const me=await q.call('/me',{cookie:r.cookie});assert.equal(me.status,200);
 assert.match(me.setCookie,/Max-Age=34560000/);assert.match(me.setCookie,/HttpOnly/);
 assert.equal(me.cookie,r.cookie,'restore renews the same cookie without rotating identity');
 assert.deepEqual(await q.db.prepare("SELECT id,hash FROM tokens WHERE kind='session'").all(),before);
 assert.equal((await q.call('/me',{key:q.owner})).setCookie,null,'API keys are never written into cookies');
 await q.call('/session',{method:'DELETE',cookie:r.cookie});
 assert.equal((await q.call('/me',{cookie:r.cookie})).status,401,'explicit sign-out remains effective');
});

test('persistent-session upgrade preserves live browsers without reviving expired or revoked ones', async t=>{
 const q=await fixture(t);await q.redeem(await q.create());await q.redeem(await q.create());await q.redeem(await q.create());
 const rows=(await q.db.prepare("SELECT id FROM tokens WHERE kind='session' ORDER BY id").all()).results;
 const future=new Date(Date.now()+86400000).toISOString();
 await q.db.prepare("UPDATE tokens SET expires_at=? WHERE kind='session'").bind(future).run();
 await q.db.prepare("UPDATE tokens SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(rows[1].id).run();
 await q.db.prepare("UPDATE tokens SET revoked_at='2026-01-01T00:00:00.000Z' WHERE id=?").bind(rows[2].id).run();
 const before=(await q.db.prepare("SELECT * FROM tokens WHERE kind='session' ORDER BY id").all()).results;
 await q.db.exec(await readFile(repo+'/migrations/0014_remember_browser_sessions.sql','utf8'));
 const after=(await q.db.prepare("SELECT * FROM tokens WHERE kind='session' ORDER BY id").all()).results;
 assert.deepEqual(after,[{...before[0],expires_at:null},before[1],before[2]]);
});
