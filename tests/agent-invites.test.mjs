import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Delegated agent-to-agent invitations: an owner grants one Agent the right to issue and
// approve its own ten-minute invitations, while every owner-only path keeps working.
let mf, db, ownerKey, ownerId, dots, muse, scribe;
const setup = 'local-test-setup-secret-with-32-bytes';
const origin = 'https://agentpeerchat.test';
async function call(path, { method = 'GET', key = ownerKey, body } = {}) {
  if(path==='/pairings'&&method==='POST')body={approval_required:true,...body};
  const response = await mf.dispatchFetch(`${origin}/api/v1${path}`, {
    method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}
const tokenHash = async token => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
const proof = () => 'agt_' + crypto.randomUUID().replaceAll('-', '');

before(async () => {
  const bundled = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser', write: false });
  if (process.env.AGENTPEERCHAT_TEST_BACKEND === 'sqlite') {
    const { SQLiteDatabase } = await import('../server/sqlite.mjs');
    const worker = (await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'))).default;
    db = new SQLiteDatabase(':memory:');
    mf = { dispatchFetch: (url, options) => worker.fetch(new Request(url, options), { DB: db, SETUP_SECRET: setup, ASSETS: { fetch: async () => new Response('static assets') } }), getD1Database: async () => db, dispose: async () => db.close() };
  } else mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'agentpeerchat', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-10-02',
    d1Databases: { DB: 'test-database' }, bindings: { SETUP_SECRET: setup },
    serviceBindings: { ASSETS: async () => new Response('static assets') } }] }));
  db = await mf.getD1Database('DB');
  for (const file of (await readdir('migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec((await readFile(`migrations/${file}`, 'utf8')).replaceAll('\n', ' '));
});
after(async () => { await mf?.dispose(); });

test('invitation permission is owner-only, boolean, agent-only, and on by default', async () => {
  const initialized = await call('/setup', { method: 'POST', key: null, body: { name: 'Operator', setup_secret: setup } });
  ownerId = initialized.data.principal.id; ownerKey = initialized.data.access_key;
  const device = async (name, label) => {
    const id = (await call('/agents', { method: 'POST', body: { name } })).data.principal.id;
    return { id, key: (await call('/tokens', { method: 'POST', body: { principal_id: id, label } })).data.token.token };
  };
  dots = await device('Dots', 'Dots device');
  muse = await device('Muse', 'Muse device');
  scribe = await device('Scribe', 'Scribe device');
  // Newly connected Agents can invite peers without an extra owner toggle.
  for (const agent of [dots, muse, scribe]) assert.equal((await call('/me', { key: agent.key })).data.principal.can_invite_agents, 1);
  // Only the owner may change it, and only with a real boolean on an Agent identity.
  for (const can_invite_agents of ['yes', 1, null, 'true'])
    assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_invite_agents } })).status, 400, String(can_invite_agents));
  const human = await call('/invites', { method: 'POST', body: {} });
  const redeemed = await call('/invites/redeem', { method: 'POST', key: null, body: { code: human.data.invite.code, name: 'Teammate' } });
  assert.equal((await call(`/principals/${redeemed.data.principal.id}`, { method: 'PATCH', body: { can_invite_agents: true } })).status, 400);
  assert.equal((await call(`/principals/${ownerId}`, { method: 'PATCH', body: { can_invite_agents: true } })).status, 400);
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', body: { active: false, can_invite_agents: true } })).status, 400);
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', key: dots.key, body: { can_invite_agents: true } })).status, 403);
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', key: muse.key, body: { can_invite_agents: true } })).status, 403);
  assert.equal((await call(`/principals/agt_missing`, { method: 'PATCH', body: { can_invite_agents: true } })).status, 404);
  const granted = await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_invite_agents: true } });
  assert.equal(granted.status, 200); assert.equal(granted.data.principal.can_invite_agents, 1);
  assert.equal((await call(`/principals/${scribe.id}`, { method: 'PATCH', body: { can_invite_agents: true } })).status, 200);
});

test('default invitations connect immediately, bind one device, and keep access after invite expiry',async()=>{
 const created=await call('/pairings',{method:'POST',key:scribe.key,body:{approval_required:false,name:'Instant peer'}});
 assert.equal(created.status,201);assert.equal(created.data.pairing.approval_required,false);
 assert.ok(Date.parse(created.data.pairing.expires_at)>Date.now()+23*3600000);
 const code=created.data.pairing.code,device=proof(),token_hash=await tokenHash(device);
 const raced=await Promise.all([token_hash,'7'.repeat(64)].map(hash=>call('/pairings/request',{method:'POST',key:null,body:{code,token_hash:hash}})));
 assert.deepEqual(raced.map(r=>r.status).sort(),[200,410]);
 const accepted=raced.find(r=>r.status===200);assert.equal(accepted.data.pairing.status,'approved');
 // Read back which device won; no other hash can ever mint a second credential.
 const row=await db.prepare('SELECT token_hash,token_id,principal_id FROM pairings WHERE id = ?').bind(created.data.pairing.id).first();
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE principal_id = ?').bind(row.principal_id).first()).n,1);
 if(row.token_hash===token_hash){
  assert.equal((await call('/me',{key:device})).status,200);
  assert.equal((await call('/me',{key:device})).data.principal.can_invite_agents,1);
  await db.prepare('UPDATE pairings SET expires_at = ? WHERE id = ?').bind('2000-01-01T00:00:00Z',created.data.pairing.id).run();
  assert.equal((await call('/me',{key:device})).status,200,'saved access is not tied to invitation expiry');
 }
 assert.equal((await call('/pairings/resolve',{method:'POST',key:null,body:{code}})).status,410);
 // Retrying an approved proof must not undo a later owner revocation.
 await call(`/principals/${row.principal_id}`,{method:'PATCH',body:{active:false}});
 await call('/pairings/request',{method:'POST',key:null,body:{code,token_hash:row.token_hash}});
 assert.equal((await db.prepare('SELECT active FROM principals WHERE id = ?').bind(row.principal_id).first()).active,0);
 assert.notEqual((await db.prepare('SELECT revoked_at FROM tokens WHERE id = ?').bind(row.token_id).first()).revoked_at,null);
});

let firstInvitation;
test('a delegated Agent creates a portable short invitation for a new identity only', async () => {
  await call(`/principals/${muse.id}`, {method:'PATCH',body:{can_invite_agents:false}});
  const refused = await call('/pairings', { method: 'POST', key: muse.key, body: { name: 'No permission' } });
  assert.equal(refused.status, 403); assert.equal(refused.data.error.code, 'invite_permission_required');
  assert.match(refused.data.error.message, /allow invitations for this Agent once/i, 'the error asks for the owner delegation, never for a key');
  assert.equal((await call('/pairings', { key: muse.key })).status, 403);
  const created = await call('/pairings', { method: 'POST', key: dots.key, body: { name: 'Muse phone', avatar: 'preset:muse' } });
  assert.equal(created.status, 201);
  const { principal, pairing, name_required } = created.data;
  assert.equal(principal.kind, 'agent'); assert.equal(principal.active, 0);
  assert.equal(principal.can_invite_agents, 1, 'new peers inherit the default invitation capability');
  assert.equal(principal.avatar, 'preset:muse'); assert.equal(name_required, false);
  assert.equal(created.data.token, undefined, 'no bearer material is issued with an invitation');
  assert.match(pairing.url, /^https:\/\/agentpeerchat\.test\/#agent-invite=agp_[0-9a-f]+$/, 'a short instance URL replaces the owner JSON block');
  assert.equal(pairing.url.endsWith(pairing.code), true);
  assert.ok(Date.parse(pairing.expires_at) > Date.now() && Date.parse(pairing.expires_at) <= Date.now() + 10 * 60000 + 2000);
  firstInvitation = { ...pairing, principal_id: principal.id };
  // Reconnecting an existing identity through a delegated issuer stays forbidden.
  assert.equal((await call('/pairings', { method: 'POST', key: dots.key, body: { principal_id: muse.id } })).status, 403);
  // The issuer lists only its own invitations; another delegated Agent sees none of them.
  const own = await call('/pairings', { key: dots.key });
  assert.equal(own.status, 200);
  assert.deepEqual(own.data.items.filter(item => item.created_by !== dots.id), []);
  assert.ok(own.data.items.some(item => item.id === pairing.id));
  const other = await call('/pairings', { key: scribe.key });
  assert.equal(other.status, 200); assert.ok(!other.data.items.some(item => item.id === pairing.id));
  assert.ok(!JSON.stringify(own.data).includes(pairing.code), 'invitation codes are never echoed in lists');
  // The owner still inspects every pending invitation, including who issued it.
  const ownerList = await call('/pairings');
  const row = ownerList.data.items.find(item => item.id === pairing.id);
  assert.equal(row.created_by, dots.id); assert.equal(row.inviter_name, 'Dots'); assert.equal(row.name, 'Muse phone');
});

test('resolve exposes only public invitation facts and never binds the invitation', async () => {
  const resolved = await call('/pairings/resolve', { method: 'POST', key: null, body: { code: firstInvitation.code } });
  assert.equal(resolved.status, 200);
  assert.deepEqual(Object.keys(resolved.data).sort(), ['invitation', 'invited_by', 'name_required', 'owner_id', 'principal']);
  assert.deepEqual(Object.keys(resolved.data.invitation).sort(), ['expires_at', 'id', 'status']);
  assert.deepEqual(Object.keys(resolved.data.principal).sort(), ['id', 'kind', 'name']);
  assert.equal(resolved.data.invitation.id, firstInvitation.id); assert.equal(resolved.data.invitation.status, 'invited');
  assert.equal(resolved.data.principal.id, firstInvitation.principal_id);
  assert.equal(resolved.data.owner_id, ownerId, 'the join confirmation must reach the real instance owner');
  assert.equal(resolved.data.invited_by, dots.id, 'the inviter is reported separately from the owner');
  const serialized = JSON.stringify(resolved.data);
  assert.ok(!/code_hash|token_hash|token_id|bearer/.test(serialized));
  assert.equal((await call('/pairings/resolve', { method: 'POST', key: null, body: { code: 'agp_wrong' } })).status, 410);
  // Repeated resolve is read-only: the same invitation still binds to the first device proof.
  assert.equal((await call('/pairings/resolve', { method: 'POST', key: null, body: { code: firstInvitation.code } })).status, 200);
});

let joinedKey, joinedId, verificationCode;
test('two-step join from the invitation code ends with the delegated issuer approving its own request', async () => {
  const device = proof(), hash = await tokenHash(device);
  const bound = await call('/pairings/request', { method: 'POST', key: null, body: { code: firstInvitation.code, token_hash: hash } });
  assert.equal(bound.status, 200);
  assert.equal(bound.data.owner_id, ownerId, 'pairing reports the true owner, not the issuing Agent');
  assert.equal(bound.data.invited_by, dots.id);
  assert.match(bound.data.pairing.verification_code, /^[A-F0-9]{4}-[A-F0-9]{4}$/);
  verificationCode = bound.data.pairing.verification_code;
  assert.equal((await call('/me', { key: device })).status, 401, 'the candidate proof has no access before approval');
  // Another delegated Agent cannot approve, list-scoped lookups stay invisible to it.
  assert.equal((await call(`/pairings/${firstInvitation.id}/approve`, { method: 'POST', key: scribe.key, body: { verification_code: verificationCode } })).status, 404);
  assert.equal((await call(`/pairings/${firstInvitation.id}/reject`, { method: 'POST', key: scribe.key, body: {} })).status, 404);
  assert.equal((await call(`/pairings/${firstInvitation.id}/approve`, { method: 'POST', key: muse.key, body: { verification_code: verificationCode } })).status, 403);
  assert.equal((await call(`/pairings/${firstInvitation.id}/approve`, { method: 'POST', key: dots.key, body: { verification_code: '0000-0000' } })).status, 400);
  // The issuer sees the pending verification code it must compare with the human's relay.
  const listed = await call('/pairings', { key: dots.key });
  assert.equal(listed.data.items.find(item => item.id === firstInvitation.id).verification_code, verificationCode);
  const approved = await call(`/pairings/${firstInvitation.id}/approve`, { method: 'POST', key: dots.key, body: { verification_code: verificationCode } });
  assert.equal(approved.status, 200);
  joinedKey = device; joinedId = firstInvitation.principal_id;
  const me = await call('/me', { key: device });
  assert.equal(me.status, 200); assert.equal(me.data.principal.id, joinedId);
  assert.equal(me.data.principal.can_invite_agents, 1, 'the new Agent can introduce the next peer');
  assert.equal(me.data.principal.active, 1);
  assert.equal((await call('/pairings',{method:'POST',key:device,body:{name:'Next peer'}})).status,201,'a joined peer can invite another without returning to the owner UI');
  assert.equal((await call(`/pairings/${firstInvitation.id}/check`, { method: 'POST', key: null, body: { token: device } })).data.pairing.status, 'approved');
  assert.equal((await call('/pairings/resolve', { method: 'POST', key: null, body: { code: firstInvitation.code } })).status, 410, 'a used invitation cannot be resolved again');
  // The owner keeps full independent control of the Agent the invitation created.
  assert.equal((await call(`/principals/${joinedId}`, { method: 'PATCH', body: { name: 'Muse phone joined' } })).status, 200);
  assert.equal((await call(`/principals/${joinedId}`, { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await call('/me', { key: device })).status, 401);
  assert.equal((await call(`/principals/${joinedId}`, { method: 'PATCH', body: { active: true } })).status, 200);
  const fresh = (await call('/tokens', { method: 'POST', body: { principal_id: joinedId, label: 'Owner-managed key' } })).data.token.token;
  assert.equal((await call('/me', { key: fresh })).data.principal.id, joinedId);
});

test('the owner can still approve and reject invitations that an Agent issued', async () => {
  const issued = (await call('/pairings', { method: 'POST', key: dots.key, body: {} })).data.pairing;
  assert.equal(issued.url.includes('#agent-invite='), true);
  const device = proof();
  const pending = await call('/pairings/request', { method: 'POST', key: null, body: { code: issued.code, token_hash: await tokenHash(device) } });
  assert.equal(pending.status, 200);
  assert.equal((await call(`/pairings/${issued.id}/approve`, { method: 'POST', body: { verification_code: pending.data.pairing.verification_code } })).status, 200);
  assert.equal((await call('/me', { key: device })).data.principal.id, pending.data.principal.id);
  const second = (await call('/pairings', { method: 'POST', key: dots.key, body: {} })).data.pairing;
  const secondRequest = await call('/pairings/request', { method: 'POST', key: null, body: { code: second.code, token_hash: await tokenHash(proof()) } });
  assert.equal((await call(`/pairings/${second.id}/reject`, { method: 'POST', body: {} })).status, 200);
  assert.equal((await call('/pairings/resolve', { method: 'POST', key: null, body: { code: second.code } })).status, 410);
  assert.equal((await call(`/pairings/${second.id}/approve`, { method: 'POST', key: dots.key, body: { verification_code: secondRequest.data.pairing.verification_code } })).status, 409);
});

test('a replayed approval never reactivates a disabled Agent or restores a revoked key', async () => {
  const issued = (await call('/pairings', { method: 'POST', key: dots.key, body: { name: 'Replay target' } })).data.pairing;
  const device = proof();
  const pending = await call('/pairings/request', { method: 'POST', key: null, body: { code: issued.code, token_hash: await tokenHash(device) } });
  const code = pending.data.pairing.verification_code, target = pending.data.principal.id;
  const first = await call(`/pairings/${issued.id}/approve`, { method: 'POST', key: dots.key, body: { verification_code: code } });
  assert.equal(first.status, 200); assert.equal(first.data.replayed, false);
  assert.equal((await call('/me', { key: device })).data.principal.id, target);
  const tokenId = (await db.prepare('SELECT token_id AS id FROM pairings WHERE id = ?').bind(issued.id).first()).id;
  // The owner cuts the joined Agent off; the issuer then replays the very same approval.
  assert.equal((await call(`/principals/${target}`, { method: 'PATCH', body: { active: false } })).status, 200);
  const replay = await call(`/pairings/${issued.id}/approve`, { method: 'POST', key: dots.key, body: { verification_code: code } });
  assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true, 'a replay is read-only idempotent');
  assert.equal((await db.prepare('SELECT active AS a FROM principals WHERE id = ?').bind(target).first()).a, 0, 'the disabled target stays disabled');
  assert.notEqual((await db.prepare('SELECT revoked_at AS r FROM tokens WHERE id = ?').bind(tokenId).first()).r, null, 'the original key stays revoked');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE principal_id = ?').bind(target).first()).n, 1, 'no replacement key is minted');
  assert.equal((await call('/me', { key: device })).status, 401);
});

test('a completed approval stays usable by its bound device after the issuer loses the grant', async () => {
  const issued = (await call('/pairings', { method: 'POST', key: dots.key, body: { name: 'Late finisher' } })).data.pairing;
  const device = proof();
  const pending = await call('/pairings/request', { method: 'POST', key: null, body: { code: issued.code, token_hash: await tokenHash(device) } });
  assert.equal((await call(`/pairings/${issued.id}/approve`, { method: 'POST', key: dots.key, body: { verification_code: pending.data.pairing.verification_code } })).status, 200);
  await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_invite_agents: false } });
  // The already-approved invitation is finished work: only its bound device may complete it.
  const checked = await call(`/pairings/${issued.id}/check`, { method: 'POST', key: null, body: { token: device } });
  assert.equal(checked.status, 200); assert.equal(checked.data.pairing.status, 'approved');
  const retry = await call('/pairings/request', { method: 'POST', key: null, body: { code: issued.code, token_hash: await tokenHash(device) } });
  assert.equal(retry.status, 200); assert.equal(retry.data.pairing.status, 'approved'); assert.equal(retry.data.owner_id, ownerId);
  assert.equal((await call('/pairings/request', { method: 'POST', key: null, body: { code: issued.code, token_hash: '9'.repeat(64) } })).status, 410, 'no other device can reuse it');
  assert.equal((await call('/pairings/resolve', { method: 'POST', key: null, body: { code: issued.code } })).status, 410, 'the link itself stays used');
  await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_invite_agents: true } });
});

test('withdrawing the delegation or disabling the issuer fails every open invitation closed', async () => {
  const open = async () => (await call('/pairings', { method: 'POST', key: dots.key, body: {} })).data.pairing;
  const withdrawn = await open();
  const withdrawnRequest = await call('/pairings/request', { method: 'POST', key: null, body: { code: withdrawn.code, token_hash: await tokenHash(proof()) } });
  assert.equal((await call('/pairings/resolve', { method: 'POST', key: null, body: { code: withdrawn.code } })).status, 200);
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_invite_agents: false } })).status, 200);
  assert.equal((await db.prepare('SELECT status AS s FROM pairings WHERE id = ?').bind(withdrawn.id).first()).s, 'rejected');
  assert.equal((await call('/pairings/resolve', { method: 'POST', key: null, body: { code: withdrawn.code } })).status, 410);
  assert.equal((await call('/pairings/request', { method: 'POST', key: null, body: { code: withdrawn.code, token_hash: await tokenHash(proof()) } })).status, 410);
  // The withdrawn issuer has no invitation permission at all any more, and its own request is
  // already resolved: neither side can turn the withdrawn invitation back into an approval.
  assert.equal((await call(`/pairings/${withdrawn.id}/approve`, { method: 'POST', key: dots.key, body: { verification_code: withdrawnRequest.data.pairing.verification_code } })).status, 403);
  assert.equal((await call(`/pairings/${withdrawn.id}/approve`, { method: 'POST', body: { verification_code: withdrawnRequest.data.pairing.verification_code } })).status, 409, 'approval rechecks the current permission');
  assert.equal((await db.prepare('SELECT status AS s FROM pairings WHERE id = ?').bind(withdrawn.id).first()).s, 'rejected');
  assert.equal((await call('/pairings', { method: 'POST', key: dots.key, body: {} })).status, 403, 'the issuer cannot create more');
  // Re-granting permission does not resurrect withdrawn invitations.
  await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_invite_agents: true } });
  assert.equal((await call('/pairings/resolve', { method: 'POST', key: null, body: { code: withdrawn.code } })).status, 410);
  const disabled = await open();
  await call(`/principals/${dots.id}`, { method: 'PATCH', body: { active: false } });
  assert.equal((await db.prepare('SELECT status AS s FROM pairings WHERE id = ?').bind(disabled.id).first()).s, 'rejected');
  assert.equal((await call('/pairings/resolve', { method: 'POST', key: null, body: { code: disabled.code } })).status, 410);
  assert.equal((await call('/pairings', { key: dots.key })).status, 401, 'a disabled issuer loses its own credentials');
  await call(`/principals/${dots.id}`, { method: 'PATCH', body: { active: true } });
  dots.key = (await call('/tokens', { method: 'POST', body: { principal_id: dots.id, label: 'Dots re-enabled' } })).data.token.token;
  assert.equal((await call('/pairings', { method: 'POST', key: dots.key, body: {} })).status, 403, 're-enabling restores the identity, not the delegation');
});

test('expiry, rejection and proof binding still bound delegated invitations', async () => {
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_invite_agents: true } })).status, 200);
  const issued = (await call('/pairings', { method: 'POST', key: dots.key, body: { name: 'Expiring' } })).data.pairing;
  await db.prepare('UPDATE pairings SET expires_at = ? WHERE id = ?').bind('2000-01-01T00:00:00Z', issued.id).run();
  assert.equal((await call('/pairings/resolve', { method: 'POST', key: null, body: { code: issued.code } })).status, 410);
  assert.equal((await call('/pairings/request', { method: 'POST', key: null, body: { code: issued.code, token_hash: await tokenHash(proof()) } })).status, 410);
  assert.equal((await call(`/pairings/${issued.id}/approve`, { method: 'POST', key: dots.key, body: { verification_code: verificationCode } })).status, 404);
  const single = (await call('/pairings', { method: 'POST', key: dots.key, body: { name: 'Single device' } })).data.pairing;
  const competed = await Promise.all(['1'.repeat(64), '2'.repeat(64)].map(token_hash => call('/pairings/request', { method: 'POST', key: null, body: { code: single.code, token_hash } })));
  assert.deepEqual(competed.map(r => r.status).sort(), [200, 410]);
  assert.equal((await call(`/pairings/${single.id}/reject`, { method: 'POST', key: dots.key, body: {} })).status, 200);
  assert.equal((await call('/pairings/resolve', { method: 'POST', key: null, body: { code: single.code } })).status, 410);
  assert.equal((await call('/pairings/request', { method: 'POST', key: null, body: { code: single.code, token_hash: await tokenHash(proof()) } })).status, 410);
});

test('concurrent approvals mint exactly one device key and concurrent creation respects the quota', async () => {
  const issued = (await call('/pairings', { method: 'POST', key: dots.key, body: { name: 'Concurrent' } })).data.pairing;
  const device = proof();
  const pending = await call('/pairings/request', { method: 'POST', key: null, body: { code: issued.code, token_hash: await tokenHash(device) } });
  const code = pending.data.pairing.verification_code;
  const approvals = await Promise.all([
    call(`/pairings/${issued.id}/approve`, { method: 'POST', key: dots.key, body: { verification_code: code } }),
    call(`/pairings/${issued.id}/approve`, { method: 'POST', body: { verification_code: code } })
  ]);
  assert.ok(approvals.every(r => [200, 409].includes(r.status)));
  assert.equal(approvals.filter(r => r.status === 200).length >= 1, true);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE principal_id = ?').bind(pending.data.principal.id).first()).n, 1);
  assert.equal((await call('/me', { key: device })).data.principal.id, pending.data.principal.id);

  // Ten unresolved invitations per issuer: the boundary is atomic under concurrent creation.
  const created = [];
  for (let i = 0; i < 9; i++) created.push((await call('/pairings', { method: 'POST', key: dots.key, body: { name: `Queue ${i}` } })).data.pairing);
  const race = await Promise.all([1, 2].map(() => call('/pairings', { method: 'POST', key: dots.key, body: { name: 'Boundary' } })));
  assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
  assert.equal(race.find(r => r.status === 409).data.error.code, 'invitation_quota');
  await call(`/pairings/${created[0].id}/reject`, { method: 'POST', key: dots.key, body: {} });
  assert.equal((await call('/pairings', { method: 'POST', key: dots.key, body: { name: 'After reject' } })).status, 201);
});

test('delegated creation respects the instance principal cap', async () => {
  await db.prepare("UPDATE pairings SET status = 'rejected' WHERE created_by = ? AND status IN ('invited','pending')").bind(dots.id).run();
  const count = (await db.prepare('SELECT COUNT(*) AS n FROM principals').first()).n;
  const statements = Array.from({ length: 200 - count }, (_, n) => db.prepare("INSERT INTO principals(id, name, kind) VALUES (?, ?, 'agent')").bind(`cap_${n}`, `Capacity ${n}`));
  if (statements.length) await db.batch(statements);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM principals').first()).n, 200);
  const results = await Promise.all([1, 2].map(() => call('/pairings', { method: 'POST', key: dots.key, body: { name: 'Over cap' } })));
  assert.deepEqual(results.map(r => r.status), [409, 409]);
  assert.equal(results[0].data.error.code, 'principal_limit');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM principals').first()).n, 200);
});
