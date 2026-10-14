import{test}from'node:test';import assert from'node:assert/strict';
import{mkdtemp,readFile,rm,stat}from'node:fs/promises';import{tmpdir}from'node:os';import{join,resolve}from'node:path';import{build}from'esbuild';
import{initializeOwner}from'../scripts/owner-init.mjs';import{createApplication}from'../server/app.mjs';
test('agent-assisted deployment creates owner once and saves a private sign-in link without exposing initialization credentials',async()=>{
 const root=await mkdtemp(join(tmpdir(),'agentpeerchat-owner-init-')),secret='private-owner-initialization-fixture-secret';
 const bundled=await build({entryPoints:['src/index.ts'],bundle:true,format:'esm',platform:'node',write:false});const worker=(await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'))).default;
 const app=await createApplication({worker,databasePath:join(root,'data.sqlite'),setupSecret:secret,publicUrl:'http://127.0.0.1',assetsDirectory:resolve('public'),migrationsDirectory:resolve('migrations')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+app.server.address().port;
 try{
  await assert.rejects(initializeOwner({url,name:'Owner',setupSecret:'wrong-but-long-enough-secret',directory:root}),/403/);
  const result=await initializeOwner({url,name:'Owner',setupSecret:secret,directory:root});assert.equal(result.initialized,true);const saved=JSON.parse(await readFile(result.file,'utf8'));assert.equal((await stat(result.file)).mode&0o777,0o600);assert.ok(!JSON.stringify(saved).includes(secret));assert.equal(new URL(saved.sign_in_url).search,'');assert.equal(new URLSearchParams(new URL(saved.sign_in_url).hash.slice(1)).get('access_key'),saved.access_key);
  assert.equal((await initializeOwner({url,name:'Another owner',setupSecret:secret,directory:root})).reused,true);assert.equal(JSON.parse(await readFile(result.file,'utf8')).access_key,saved.access_key);
  const other=await initializeOwner({url,name:'Someone',setupSecret:secret,directory:join(root,'different-deploy')});assert.equal(other.requires_existing_login,true);
  const session=await fetch(url+'/api/v1/session',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1'},body:JSON.stringify({access_key:saved.access_key})});assert.equal(session.status,200);assert.match(session.headers.get('set-cookie'),/HttpOnly/);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
