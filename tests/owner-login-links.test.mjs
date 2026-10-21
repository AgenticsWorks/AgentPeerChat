import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Delegated owner sign-in help: a default-on revocable per-Agent permission lets one trusted Agent
// mint ten-minute single-use owner browser sign-in links, with every revocation path ending
// unresolved links and already-redeemed sessions at once.
let mf, db, ownerKey, ownerId, dots, muse, outsider;
const setup = 'local-test-setup-secret-with-32-bytes';
const origin = 'https://agentpeerchat.test';
async function call(path, { method = 'GET', key, body, originHeader, cookie } = {}) {
  const authKey = key === undefined ? (cookie ? null : ownerKey) : key;
  const response = await mf.dispatchFetch(`${origin}/api/v1${path}`, {
    method, headers: {
      ...(authKey ? { Authorization: `Bearer ${authKey}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(originHeader ? { Origin: originHeader } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    }, body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json(), response };
}
const sha256 = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');

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

test('sign-in help permission is owner-only, boolean, agent-only, on by default and independent of invitations', async () => {
  const initialized = await call('/setup', { method: 'POST', key: null, body: { name: 'Operator', setup_secret: setup } });
  ownerId = initialized.data.principal.id; ownerKey = initialized.data.access_key;
  const device = async (name, label) => {
    const id = (await call('/agents', { method: 'POST', body: { name } })).data.principal.id;
    return { id, key: (await call('/tokens', { method: 'POST', body: { principal_id: id, label } })).data.token.token };
  };
  dots = await device('Dots', 'Dots device');
  muse = await device('Muse', 'Muse device');
  outsider = await device('Observer', 'Observer device');
  // Personal-Agent pairing includes browser access by default.
  for (const agent of [dots, muse]) assert.equal((await call('/me', { key: agent.key })).data.principal.can_help_owner_login, 1);
  // Only the owner may change it, only with a real boolean, and only on an Agent identity.
  for (const can_help_owner_login of ['yes', 1, null, 'true'])
    assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_help_owner_login } })).status, 400, String(can_help_owner_login));
  const human = await call('/invites', { method: 'POST', body: {} });
  const redeemed = await call('/invites/redeem', { method: 'POST', key: null, body: { code: human.data.invite.code, name: 'Teammate' } });
  assert.equal((await call(`/principals/${redeemed.data.principal.id}`, { method: 'PATCH', body: { can_help_owner_login: true } })).status, 400);
  assert.equal((await call(`/principals/${ownerId}`, { method: 'PATCH', body: { can_help_owner_login: true } })).status, 400);
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', body: { active: false, can_help_owner_login: true } })).status, 400);
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', key: dots.key, body: { can_help_owner_login: true } })).status, 403);
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', key: muse.key, body: { can_help_owner_login: true } })).status, 403);
  assert.equal((await call(`/principals/agt_missing`, { method: 'PATCH', body: { can_help_owner_login: true } })).status, 404);
  // The invitation delegation confers no sign-in power, and vice versa.
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_invite_agents: true } })).status, 200);
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_help_owner_login: false } })).status, 200);
  assert.equal((await call('/owner-login-links', { method: 'POST', key: dots.key, body: {} })).status, 403);
  assert.equal((await call(`/principals/${muse.id}`, { method: 'PATCH', body: { can_invite_agents: false } })).status, 200);
  assert.equal((await call(`/principals/${muse.id}`, { method: 'PATCH', body: { can_help_owner_login: true } })).status, 200);
  assert.equal((await call('/pairings', { method: 'POST', key: muse.key, body: {} })).status, 403);
  const invited = (await call('/pairings', { method: 'POST', key: dots.key, body: { name: 'Invited peer' } })).data.pairing;
  const delegatedAgent = (await db.prepare('SELECT principal_id AS id FROM pairings WHERE id = ?').bind(invited.id).first()).id;
  assert.equal((await db.prepare('SELECT can_help_owner_login AS c FROM principals WHERE id = ?').bind(delegatedAgent).first()).c, 1, 'an invited personal Agent receives its own browser capability by default');
  // Leave only Dots delegated for the issuance flow that follows.
  assert.equal((await call(`/principals/${muse.id}`, { method: 'PATCH', body: { can_help_owner_login: false } })).status, 200);
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_help_owner_login: true } })).status, 200);
});

test('a delegated Agent mints one-use links only with its own access key and known threads', async () => {
  const refused = await call('/owner-login-links', { method: 'POST', key: muse.key, body: {} });
  assert.equal(refused.status, 403); assert.equal(refused.data.error.code, 'login_permission_required');
  assert.match(refused.data.error.message, /explicitly disabled/i, 'the error names the owner delegation, never a key');
  // Humans and browser sessions cannot mint links.
  assert.equal((await call('/owner-login-links', { method: 'POST', body: {} })).status, 403);
  const session = await call('/session', { method: 'POST', key: null, originHeader: origin, body: { access_key: ownerKey } });
  const cookie = session.response.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await call('/owner-login-links', { method: 'POST', cookie, originHeader: origin, body: {} })).status, 403);
  // Thread targets must be the issuer's own membership: this group excludes Dots.
  const foreign = (await call('/threads', { method: 'POST', key: muse.key, body: { title: 'Muse and owner', members: [ownerId] } })).data.thread;
  assert.equal((await call('/owner-login-links', { method: 'POST', key: dots.key, body: { thread_id: foreign.id } })).status, 404);
  for (const thread_id of [42, 'x'.repeat(81)]) assert.equal((await call('/owner-login-links', { method: 'POST', key: dots.key, body: { thread_id } })).status, 400);
  const group = (await call('/threads', { method: 'POST', key: muse.key, body: { title: 'With Dots', members: [dots.id] } })).data.thread;
  const created = await call('/owner-login-links', { method: 'POST', key: dots.key, body: { thread_id: group.id } });
  assert.equal(created.status, 201);
  const link = created.data.login_link;
  assert.ok(Date.parse(link.expires_at) > Date.now() && Date.parse(link.expires_at) <= Date.now() + 10 * 60000 + 2000);
  assert.match(link.fragment, /^#owner-login=agl_[0-9a-f]{64}&thread=thr_/);
  assert.equal(new URL(link.url).hash, link.fragment, 'the absolute URL agrees with the base-independent fragment');
  assert.ok(!JSON.stringify(created.data).includes('access_key') && !JSON.stringify(created.data).includes('"token"'));
  // Only the SHA-256 hash is stored; the raw code and any key material never reach the database.
  const row = await db.prepare('SELECT * FROM owner_login_grants WHERE id = ?').bind(link.id).first();
  const code = link.fragment.slice('#owner-login='.length).split('&')[0];
  assert.equal(row.code_hash, await sha256(code)); assert.equal(row.issuer_id, dots.id); assert.equal(row.owner_id, ownerId);
  assert.equal(row.thread_id, group.id); assert.equal(row.redeemed_at, null);
  assert.ok(!JSON.stringify(row).includes(code));
  const listed = await call('/owner-login-links', { key: dots.key });
  assert.equal(listed.status, 200);
  assert.ok(listed.data.items.some(item => item.id === link.id && item.thread_id === group.id));
  assert.ok(!JSON.stringify(listed.data).includes(code), 'codes are never echoed in lists');
  assert.equal((await call('/owner-login-links', { key: muse.key })).status, 403, 'another Agent sees none of them');
});

test('redeem requires a same-origin POST, mints an HttpOnly session and never an access key', async () => {
  const link = (await call('/owner-login-links', { method: 'POST', key: dots.key, body: {} })).data.login_link;
  const code = link.fragment.slice('#owner-login='.length);
  for (const options of [{}, { originHeader: 'https://evil.test' }]) {
    const blocked = await call('/owner-login/redeem', { method: 'POST', key: null, ...options, body: { code } });
    assert.equal(blocked.status, 403, 'redemption needs the app’s own same-origin POST');
  }
  assert.equal((await call('/owner-login/redeem', { method: 'POST', key: null, originHeader: origin, body: {} })).status, 400);
  assert.equal((await call('/owner-login/redeem', { method: 'POST', key: null, originHeader: origin, body: { code: 'agl_wrong' } })).status, 410);
  const redeemed = await call('/owner-login/redeem', { method: 'POST', key: null, originHeader: origin, body: { code } });
  assert.equal(redeemed.status, 200); assert.equal(redeemed.data.principal.kind, 'owner'); assert.equal(redeemed.data.principal.id, ownerId);
  assert.equal(redeemed.data.access_key, undefined, 'redemption returns no access key');
  const setCookie = redeemed.response.headers.getSetCookie()[0];
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Max-Age=34560000/);
  loginCookie = setCookie.split(';')[0];
  const me = await call('/me', { cookie: loginCookie });
  assert.equal(me.status, 200); assert.equal(me.data.principal.id, ownerId);
  // The owner session sees every thread, including the agent-scoped one it was pointed at.
  const group = (await call('/threads', { method: 'POST', key: muse.key, body: { title: 'Agents only', members: [dots.id] } })).data.thread;
  const targeted = (await call('/owner-login-links', { method: 'POST', key: dots.key, body: { thread_id: group.id } })).data.login_link;
  const second = await call('/owner-login/redeem', { method: 'POST', key: null, originHeader: origin, body: { code: targeted.fragment.slice('#owner-login='.length).split('&')[0] } });
  const secondCookie = second.response.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await call(`/threads/${group.id}`, { cookie: secondCookie })).status, 200, 'the deep-linked thread opens after one-use login');
  assert.equal((await call(`/threads/${group.id}`, { key: outsider.key })).status, 404, 'non-members still cannot');
  // Browser sessions persist until withdrawal and stay bound to their original grant.
  const sessionRow = await db.prepare("SELECT * FROM tokens WHERE kind = 'session' AND owner_login_grant_id = ?").bind(targeted.id).first();
  assert.equal(sessionRow.expires_at, null);
  assert.ok(!JSON.stringify(sessionRow).includes(secondCookie.slice('ag_session='.length)), 'only the session hash is stored');
});

let loginCookie;
test('a redeemed link is one-use: replays and concurrent redemptions produce exactly one session', async () => {
  const link = (await call('/owner-login-links', { method: 'POST', key: dots.key, body: {} })).data.login_link;
  const code = link.fragment.slice('#owner-login='.length);
  const raced = await Promise.all([1, 2].map(() => call('/owner-login/redeem', { method: 'POST', key: null, originHeader: origin, body: { code } })));
  assert.deepEqual(raced.map(r => r.status).sort(), [200, 410]);
  assert.equal((await call('/owner-login/redeem', { method: 'POST', key: null, originHeader: origin, body: { code } })).status, 410);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE owner_login_grant_id = ?').bind(link.id).first()).n, 1, 'no orphan session tokens for losers');
  const winnerCookie = raced.find(r => r.status === 200).response.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await call('/me', { cookie: winnerCookie })).data.principal.id, ownerId);
});

test('expiry closes unredeemed links and expired rows are cleaned up', async () => {
  const link = (await call('/owner-login-links', { method: 'POST', key: dots.key, body: {} })).data.login_link;
  await db.prepare('UPDATE owner_login_grants SET expires_at = ? WHERE id = ?').bind('2000-01-01T00:00:00Z', link.id).run();
  assert.equal((await call('/owner-login/redeem', { method: 'POST', key: null, originHeader: origin, body: { code: link.fragment.slice('#owner-login='.length) } })).status, 410);
  await call('/owner-login-links', { method: 'POST', key: dots.key, body: {} });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM owner_login_grants WHERE id = ?').bind(link.id).first()).n, 0, 'expired grants are removed by the next write');
});

test('withdrawal, disablement and issuer key revocation end links and already-redeemed sessions', async () => {
  const grant = async () => (await call('/owner-login-links', { method: 'POST', key: dots.key, body: {} })).data.login_link;
  const redeem = async link => call('/owner-login/redeem', { method: 'POST', key: null, originHeader: origin, body: { code: link.fragment.slice('#owner-login='.length) } });

  // Withdrawing the permission.
  const openLink = await grant(); const redeemedLink = await grant();
  const withdrawnSession = (await redeem(redeemedLink)).response.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await call('/me', { cookie: withdrawnSession })).status, 200);
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_help_owner_login: false } })).status, 200);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM owner_login_grants WHERE issuer_id = ? AND redeemed_at IS NULL').bind(dots.id).first()).n, 0, 'unresolved links are removed atomically');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE owner_login_grant_id IN (SELECT id FROM owner_login_grants WHERE issuer_id = ?) AND revoked_at IS NULL").bind(dots.id).first()).n, 0, 'redeemed sessions are revoked with the withdrawal');
  assert.equal((await redeem(openLink)).status, 410);
  assert.equal((await call('/me', { cookie: withdrawnSession })).status, 401, 'an already-redeemed session dies with the withdrawal');
  assert.equal((await call('/owner-login-links', { method: 'POST', key: dots.key, body: {} })).status, 403);
  // Re-granting the permission must never revive the withdrawn session, while new links work.
  await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_help_owner_login: true } });
  assert.equal((await call('/me', { cookie: withdrawnSession })).status, 401, 'revocation survives a re-grant');
  const freshLink = await grant();
  const freshSession = (await redeem(freshLink)).response.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await call('/me', { cookie: freshSession })).data.principal.id, ownerId, 'only a newly redeemed link signs in again');

  // Disabling the issuer also ends its own credentials and any login session.
  const dotsKey = dots.key;
  const disabledOpen = await grant(); const disabledRedeemed = await grant();
  const disabledSession = (await redeem(disabledRedeemed)).response.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await call(`/principals/${dots.id}`, { method: 'PATCH', body: { active: false } })).status, 200);
  assert.equal((await db.prepare('SELECT can_help_owner_login AS c FROM principals WHERE id = ?').bind(dots.id).first()).c, 0, 'disabling clears the delegation');
  assert.equal((await redeem(disabledOpen)).status, 410);
  assert.equal((await call('/me', { cookie: disabledSession })).status, 401);
  assert.equal((await call('/me', { key: dotsKey })).status, 401);
  await call(`/principals/${dots.id}`, { method: 'PATCH', body: { active: true } });
  dots.key = (await call('/tokens', { method: 'POST', body: { principal_id: dots.id, label: 'Dots replacement' } })).data.token.token;
  await call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_help_owner_login: true } });
  assert.equal((await call('/owner-login-links', { method: 'POST', key: dots.key, body: {} })).status, 201, 'regranting after a clean disable works again');

  // Revoking the issuer access key that minted the links.
  const mintingKey = dots.key;
  const keyOpen = (await call('/owner-login-links', { method: 'POST', key: mintingKey, body: {} })).data.login_link;
  const keyRedeemed = (await call('/owner-login-links', { method: 'POST', key: mintingKey, body: {} })).data.login_link;
  const keySession = (await redeem(keyRedeemed)).response.headers.getSetCookie()[0].split(';')[0];
  const mintingKeyId = (await db.prepare("SELECT id FROM tokens WHERE principal_id = ? AND kind = 'access' AND revoked_at IS NULL AND hash = ?").bind(dots.id, await sha256(mintingKey)).first()).id;
  dots.key = (await call('/tokens', { method: 'POST', body: { principal_id: dots.id, label: 'Dots surviving key' } })).data.token.token;
  assert.equal((await call(`/tokens/${mintingKeyId}`, { method: 'DELETE' })).status, 200);
  assert.equal((await redeem(keyOpen)).status, 410);
  assert.equal((await call('/me', { cookie: keySession })).status, 401);
  assert.equal((await call('/me', { key: mintingKey })).status, 401, 'the issuer key itself was revoked');
});

test('ordinary owner keys and sessions are untouched by the delegation lifecycle', async () => {
  const ordinary = await call('/session', { method: 'POST', key: null, originHeader: origin, body: { access_key: ownerKey } });
  const ordinaryCookie = ordinary.response.headers.getSetCookie()[0].split(';')[0];
  assert.equal((await call(`/principals/${muse.id}`, { method: 'PATCH', body: { can_help_owner_login: false } })).status, 200);
  assert.equal((await call('/me', { key: ownerKey })).status, 200);
  assert.equal((await call('/me', { cookie: ordinaryCookie })).status, 200, 'ordinary owner sessions never recheck the delegation');
  assert.equal((await call('/overview', { cookie: ordinaryCookie })).status, 200);
});

test('open-link quota is atomic under concurrent creation', async () => {
  await db.prepare('DELETE FROM owner_login_grants WHERE issuer_id = ? AND redeemed_at IS NULL').bind(dots.id).run();
  for (let i = 0; i < 9; i++) await call('/owner-login-links', { method: 'POST', key: dots.key, body: {} });
  const race = await Promise.all([1, 2].map(() => call('/owner-login-links', { method: 'POST', key: dots.key, body: {} })));
  assert.deepEqual(race.map(r => r.status).sort(), [201, 409]);
  assert.equal(race.find(r => r.status === 409).data.error.code, 'login_link_quota');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM owner_login_grants WHERE issuer_id = ? AND redeemed_at IS NULL').bind(dots.id).first()).n, 10);
  const boundary = await call('/owner-login-links', { method: 'POST', key: dots.key, body: {} });
  assert.equal(boundary.status, 409);
  await db.prepare('DELETE FROM owner_login_grants WHERE issuer_id = ? AND redeemed_at IS NULL').bind(dots.id).run();
  // A concurrent withdrawal after authentication still cannot leave a usable link behind.
  const racedWithdrawal = await Promise.all([
    call(`/principals/${dots.id}`, { method: 'PATCH', body: { can_help_owner_login: false } }),
    call('/owner-login-links', { method: 'POST', key: dots.key, body: {} })
  ]);
  const createdDuringWithdrawal = racedWithdrawal[1];
  if (createdDuringWithdrawal.status === 201) {
    const racedCode = createdDuringWithdrawal.data.login_link.fragment.slice('#owner-login='.length);
    assert.equal((await call('/owner-login/redeem', { method: 'POST', key: null, originHeader: origin, body: { code: racedCode } })).status, 410);
  } else assert.equal(createdDuringWithdrawal.status, 403);
  assert.equal((await call('/owner-login-links', { method: 'POST', key: dots.key, body: {} })).status, 403, 'the withdrawal wins the race boundary');
});
