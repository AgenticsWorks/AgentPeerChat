import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {SQLiteDatabase} from '../server/sqlite.mjs';

const stamp='2026-10-16T00:00:00.000Z';
const compiled=await build({entryPoints:['src/pairing.ts'],bundle:true,format:'esm',platform:'node',write:false,
  define:{Date:'FixedDate'},banner:{js:`const OriginalDate=globalThis.Date;const FixedDate=class extends OriginalDate{constructor(...a){super(...(a.length?a:[${JSON.stringify(stamp)}]))}static now(){return ${Date.parse(stamp)}}};`}});
const {pairingOwner}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
async function fixture(t){
  const db=new SQLiteDatabase(':memory:');t.after(()=>db.close());await db.migrate('migrations');
  await db.exec("INSERT INTO principals(id,name,kind) VALUES ('hum_owner','Owner','owner');INSERT INTO principals(id,name,kind,can_invite_agents) VALUES ('agt_issuer','Issuer','agent',1);INSERT INTO principals(id,name,kind,active) VALUES ('agt_target','Target','agent',0);");
  return {db,p:await db.prepare("SELECT * FROM principals WHERE id='agt_issuer'").first()};
}
const request=(path,data)=>new Request('https://example.test/api/v1'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
test('approval replay in the same clock tick preserves an owner-disabled identity and revoked key',async t=>{
  const {db,p}=await fixture(t);
  await db.prepare("INSERT INTO pairings(id,principal_id,created_by,code_hash,token_id,token_hash,verification_code,status,expires_at) VALUES ('pair_test','agt_target','agt_issuer','code_hash','tok_test','proof_hash','ABCD-1234','pending','2099-01-01T00:00:00.000Z')").run();
  const path='/pairings/pair_test/approve',data={verification_code:'ABCD-1234'};
  assert.equal((await pairingOwner(request(path,data),{DB:db},path,p)).status,200);
  await db.exec("UPDATE principals SET active=0 WHERE id='agt_target';UPDATE tokens SET revoked_at='2026-10-16T00:00:00.000Z' WHERE id='tok_test';");
  assert.equal((await pairingOwner(request(path,data),{DB:db},path,p)).status,200);
  assert.equal((await db.prepare("SELECT active FROM principals WHERE id='agt_target'").first()).active,0);
  assert.equal((await db.prepare("SELECT revoked_at FROM tokens WHERE id='tok_test'").first()).revoked_at,stamp);
});
test('delegation withdrawn after authentication but before the create batch grants no invitation or identity',async t=>{
  const {db,p}=await fixture(t),before=(await db.prepare('SELECT COUNT(*) AS n FROM principals').first()).n;
  const realBatch=db.batch.bind(db);let withdrew=false;
  db.batch=async statements=>{
    if(!withdrew){withdrew=true;await db.prepare("UPDATE principals SET can_invite_agents=0 WHERE id='agt_issuer'").run();}
    return realBatch(statements);
  };
  await assert.rejects(pairingOwner(request('/pairings',{name:'No grant'}),{DB:db},'/pairings',p),error=>error.status===403);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM principals').first()).n,before);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM pairings').first()).n,0);
});
