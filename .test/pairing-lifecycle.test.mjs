import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {completePairing,clearPairing} from '../scripts/pairing-client.mjs';

// The bounded path must expose only safe pairing status, persist a private proof, and never
// return access before the owner approves. Reruns must reuse the same locally generated proof.
test('bounded pairing returns only status and reuses the private proof after approval', async t => {
 const directory=await mkdtemp(join(tmpdir(),'agentpeerchat-bounded-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const config={url:'https://pair.example',principal_id:'agt_bounded',pairing:{id:'pair_bounded',code:'agp_secret_invitation'}};
 let approved=false;const hashes=[],notified=[];
 const fetchImpl=async(url,options)=>{
  const body=JSON.parse(options.body);
  assert.ok(url.endsWith('/pairings/request'),'The bounded path must not poll before approval');
  hashes.push(body.token_hash);assert.equal(body.code,config.pairing.code);
  return new Response(JSON.stringify({principal:{id:config.principal_id},owner_id:'hum_owner',token_id:'tok_bounded',
   pairing:{id:config.pairing.id,verification_code:'BND1-2345',status:approved?'approved':'pending',expires_at:new Date(Date.now()+60000).toISOString()}}));
 };
 const notify=text=>notified.push(text);
 const first=await completePairing(config,directory,{fetchImpl,notify,noWait:true});
 assert.equal(first.pending,true);assert.equal(first.status,'pending');assert.equal(first.verification_code,'BND1-2345');
 for(const key of ['token','token_id','owner_id','pairing'])assert.equal(first[key],undefined,`The pending result must not expose ${key}`);
 assert.deepEqual(notified,[],'The pairing client must not print directly on the pending path');
 const proofFile=join(directory,'pending-pairing.json');
 const proof=JSON.parse(await readFile(proofFile,'utf8'));
 assert.match(proof.token,/^agt_[a-f0-9]{64}$/);assert.equal((await stat(proofFile)).mode&0o777,0o600);
 assert.ok(!JSON.stringify(first).includes(proof.token));

 approved=true;
 const second=await completePairing(config,directory,{fetchImpl,notify,noWait:true});
 assert.equal(second.token,proof.token);assert.equal(second.token_id,'tok_bounded');assert.equal(second.owner_id,'hum_owner');assert.equal(second.pairing,undefined);
 assert.equal(hashes.length,2);assert.equal(hashes[0],hashes[1],'A rerun must bind the same invitation to the same proof');
 assert.equal(hashes[0],createHash('sha256').update(proof.token).digest('hex'));
 const shown=notified.join(' ');
 assert.equal(shown,'','an already-approved rerun prints no pairing code; the pending descriptor carried it');
 assert.ok(!shown.includes(proof.token));assert.ok(!shown.includes(config.pairing.code));
 await clearPairing(directory);await assert.rejects(stat(proofFile));
});

test('bounded pairing fails closed on rejection and expiry without releasing a bearer key', async t => {
 const directory=await mkdtemp(join(tmpdir(),'agentpeerchat-bounded-fail-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const config={url:'https://pair.example',principal_id:'agt_bounded',pairing:{id:'pair_bounded',code:'agp_secret_invitation'}};
 const reply=status=>async()=>new Response(JSON.stringify({principal:{id:config.principal_id},owner_id:'hum_owner',token_id:'tok_bounded',
  pairing:{id:config.pairing.id,verification_code:'BND1-2345',status,expires_at:status==='pending'?new Date(Date.now()-1000).toISOString():new Date(Date.now()+60000).toISOString()}}));
 const options={notify:()=>{},noWait:true};
 await assert.rejects(completePairing(config,directory,{...options,fetchImpl:reply('rejected')}),/rejected or expired/);
 await assert.rejects(completePairing(config,directory,{...options,fetchImpl:reply('pending')}),/rejected or expired/);
 assert.ok(!(await readFile(join(directory,'pending-pairing.json'),'utf8')).includes('"token_id"'));
});
