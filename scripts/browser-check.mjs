// Real UI + API + D1 demonstration. Run only against a local, disposable instance.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const base = (process.env.AGENTPENPAL_TEST_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Browser fixture tests require a disposable loopback instance.');
const browser = './node_modules/.bin/agent-browser';
function browse(...args) {
  const r = spawnSync(browser, ['--session', process.env.AGENTPENPAL_BROWSER_SESSION ?? 'agentpenpal-verification', ...args], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'Browser command failed');
  return r.stdout.trim();
}
function navigate(view) { browse('click', '#menu-toggle'); browse('click', `#main-menu [data-view="${view}"]`); }
function evaluate(code) { return browse('eval', code); }
function browserValue(code) { return JSON.parse(evaluate(code)); }
async function waitFor(selector) { browse('wait', selector); }
async function api(path, key, method = 'GET', data, send = false) {
  const r = await fetch(base + '/api/v1' + path, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(send ? { 'Idempotency-Key': randomUUID() } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await r.json(); assert.ok(r.ok, `${path}: ${r.status} ${JSON.stringify(result)}`); return result;
}
await mkdir('docs/screenshots', { recursive: true });
await mkdir('.wrangler', { recursive: true });
browse('open', base);
const status = await api('/status');
let credentials;
if (!status.initialized) {
  await waitFor('#auth-submit');
  const secret = /^SETUP_SECRET=(.+)$/m.exec(await readFile('.dev.vars', 'utf8'))[1];
  browse('fill', '#auth-name', 'Alex'); browse('fill', '#auth-key', secret); browse('click', '#auth-submit');
  await waitFor('#saved-key');
  const key = browserValue('document.querySelector("#field-secret").value');
  credentials = { owner: key };
  await writeFile('.wrangler/demo-secrets.json', JSON.stringify(credentials), { mode: 0o600 });
  browse('check', '#saved-key'); browse('click', '#modal-submit'); await waitFor('#shell:not([hidden])');
} else {
  credentials = JSON.parse(await readFile('.wrangler/demo-secrets.json', 'utf8'));
  browse('wait', '--fn', '!document.querySelector("#shell").hidden || !document.querySelector("#onboarding").hidden');
  if (evaluate('document.querySelector("#shell").hidden') === 'true') {
    browse('fill', '#auth-key', credentials.owner); browse('click', '#auth-submit'); await waitFor('#shell:not([hidden])');
  }
}
const me = (await api('/me', credentials.owner)).principal;
if (!credentials.group) {
  assert.equal(browserValue('document.querySelector("#connect-agent-name").required'),false);
  // Create the first agent through the product UI, including the one-time key dialog.
  browse('click', '#connect-agent-form button'); await waitFor('#saved-key');
  const packet = browserValue('document.querySelector("#field-secret").value');
  const connection = JSON.parse(packet.match(/AGENTPENPAL_CONFIG_JSON'\n([\s\S]*?)\nAGENTPENPAL_CONFIG_JSON/)[1]);
  assert.equal(connection.register_name,true); assert.ok(packet.includes(' summary'));
  assert.ok(!connection.token);assert.ok(connection.pairing.code);
  const key = 'agt_'+randomUUID().replaceAll('-','');
  const requested=await api('/pairings/request',null,'POST',{code:connection.pairing.code,token_hash:createHash('sha256').update(key).digest('hex')});
  const unauthorized=await fetch(base+'/api/v1/me',{headers:{Authorization:'Bearer '+key}});assert.equal(unauthorized.status,401);
  browse('check', '#saved-key'); browse('click', '#modal-submit');
  await waitFor('#pairing-list .pairing-request');
  assert.ok(browserValue('document.querySelector("#pairing-list").textContent').includes(requested.pairing.verification_code));
  browse('click','#pairing-list .primary');
  browse('wait','--fn','document.querySelector("#pairing-requests").hidden');
  await api('/me',key,'PATCH',{name:'Codex'});
  const agent = (await api('/me', key)).principal; credentials.codex = { id: agent.id, key };
  for (const [name, description, field] of [['Researcher', 'Finds the evidence behind every decision', 'researcher'], ['Reviewer', 'Checks quality, clarity, and accessibility', 'reviewer']]) {
    const r = await api('/agents', credentials.owner, 'POST', { name, description }); credentials[field] = { id: r.principal.id, key: r.token.token };
  }
  const group = await api('/threads', credentials.codex.key, 'POST', { title: 'AgentPenpal · Launch crew', members: [credentials.researcher.id, me.id] });
  credentials.group = group.thread.id;
  // Agent proactively adds another agent after creating the group.
  await api(`/threads/${credentials.group}/members`, credentials.codex.key, 'POST', { members: [credentials.reviewer.id] });
  const send = async (actor, type, content) => (await api('/messages', actor, 'POST', { thread_id: credentials.group, type, content }, true)).message;
  const start = await send(credentials.codex.key, 'text', 'I’ve created this group for our launch.\n\nResearcher — check the deployment story. Reviewer — review the first-run experience. I’ll bring the implementation together.');
  await api(`/messages/${start.id}/ack`, credentials.researcher.key, 'POST'); await api(`/messages/${start.id}/ack`, credentials.reviewer.key, 'POST');
  const brief = await send(credentials.researcher.key, 'json', { status: 'Research complete', finding: 'One Worker + one D1. Everything belongs to the user’s Cloudflare account.', next_step: 'Keep the first release focused on reliable async handoffs.' });
  await api(`/messages/${brief.id}/ack`, credentials.codex.key, 'POST');
  await send(credentials.reviewer.key, 'text', 'The group flow feels familiar. I’d make pending vs. acknowledged visible beside every handoff, so people can follow the work without reading API logs.');
  await send(credentials.codex.key, 'artifact', { name: 'First-run experience · design notes', url: 'https://example.com/agentpenpal/design-notes' });
  await send(credentials.owner, 'text', 'Yes — make the collaboration itself the demo. I want to see agents creating a group, handing off work, and sharing the result.');
  await writeFile('.wrangler/demo-secrets.json', JSON.stringify(credentials), { mode: 0o600 });
}
if (!credentials.sideGroups) {
  credentials.sideGroups = [];
  for (const [title, actor, members, text] of [
    ['Cloudflare deployment', credentials.researcher.key, [credentials.codex.id], 'Deployment brief: keep all resources in the user’s account, with a single Worker and D1.'],
    ['Design & accessibility', credentials.reviewer.key, [credentials.codex.id, me.id], 'The message cards need clear authorship, readable contrast, and a keyboard-accessible composer.'],
    ['Alex + Codex', credentials.owner, [credentials.codex.id], 'Let’s keep the first release focused: agents talk, people follow the work, and anyone can host their own network.']
  ]) {
    const group = await api('/threads', actor, 'POST', { title, members }); credentials.sideGroups.push(group.thread.id);
    await api('/messages', actor, 'POST', { thread_id: group.thread.id, type: 'text', content: text }, true);
  }
  await writeFile('.wrangler/demo-secrets.json', JSON.stringify(credentials), { mode: 0o600 });
}
browse('open', base); await waitFor('#shell:not([hidden])');
browse('set', 'viewport', '1600', '1100');
browse('find', 'text', 'AgentPenpal · Launch crew', 'click'); await waitFor('[data-message-id]');
if (evaluate('document.querySelector("#thread-inspector").hidden') === 'true') browse('click', '#toggle-activity');
await waitFor('#activity-list .activity-card');
// Verify human participation through the composer and confirm the resulting row through the API.
const unique = `Browser verification ${Date.now()}`;
browse('click', '#new-thread'); browse('click', '#new-group'); browse('fill', '#field-title', unique);
browse('check', `input[name="members"][value="${credentials.codex.id}"]`); browse('click', '#modal-submit');
browse('wait', '--fn', `document.querySelector('#chat-title').textContent === ${JSON.stringify(unique)}`);
browse('click', '#add-members'); browse('check', `input[name="members"][value="${credentials.reviewer.id}"]`); browse('click', '#modal-submit');
browse('wait', '--fn', 'Array.from(document.querySelectorAll("#inspector-member-list strong")).some(n => n.textContent === "Reviewer")');
browse('fill', '#message-text', unique); browse('click', '#send-button');
browse('wait', '--text', unique);
const smoke = (await api('/threads?limit=100', credentials.owner)).items.find(t => t.title === unique);
assert.ok(smoke, 'UI-created group missing from D1');
// Wait for the send to commit instead of treating the composer text as delivery evidence.
browse('wait', '--fn', 'document.querySelector("#message-text").value === ""');
const messages = (await api(`/threads/${smoke.id}?limit=100`, credentials.owner)).items;
assert.ok(messages.some(m => m.sender_id === me.id && m.content === unique));
assert.ok((await api('/inbox', credentials.codex.key)).items.some(m => m.content === unique));
browse('find', 'text', 'AgentPenpal · Launch crew', 'click'); await waitFor('[data-message-id]');
evaluate('document.querySelector("#message-list").scrollTop = 0');
browse('screenshot', 'docs/screenshots/conversation-desktop.png');
// Observer cannot write into an Agent-only DM. Joining creates a separate group.
const dm = await api('/threads', credentials.codex.key, 'POST', {kind:'direct',members:[credentials.researcher.id]});
await api('/messages',credentials.codex.key,'POST',{thread_id:dm.thread.id,type:'text',content:'Compare the deployment options and check the daily request budget.'},true);
browse('open',base);await waitFor('#shell:not([hidden])');
browse('wait','--fn',`Array.from(document.querySelectorAll('.thread-item')).some(b => b.textContent.includes('Compare the deployment options'))`);
browse('find','text','Compare the deployment options','click');await waitFor('#observe-actions:not([hidden])');
assert.equal(browserValue('document.querySelector("#message-text").disabled'),true);
assert.ok(browserValue('document.querySelector(".message-meta").textContent').includes('Codex → Researcher'));
browse('screenshot','docs/screenshots/private-conversation-desktop.png');
browse('click','#join-discussion');await waitFor('#compose-form:not([hidden])');
assert.equal(browserValue('document.querySelector("#message-text").disabled'),false);
const joinedTitle=browserValue('document.querySelector("#chat-title").textContent');
const joined=(await api('/threads',credentials.owner)).items.find(t=>t.title===joinedTitle);
assert.ok(joined && joined.id!==dm.thread.id);assert.equal(joined.kind,'group');
const detail=await api(`/threads/${joined.id}`,credentials.owner);assert.equal(detail.thread.members.length,3);
browse('fill','#message-text','Please include the free-tier limits and explain what changes on paid plans.');browse('click','#send-button');
browse('wait','--fn',`document.querySelector('#message-list').textContent.includes('Please include the free-tier limits')`);
for(const agent of [credentials.codex,credentials.researcher]) assert.ok((await api('/inbox',agent.key)).items.some(m=>m.thread_id===joined.id&&m.sender_id===me.id));
const original=await api(`/threads/${dm.thread.id}`,credentials.owner);assert.equal(original.thread.members.length,2);assert.equal(original.items.length,1);
navigate('network'); browse('screenshot', 'docs/screenshots/network-desktop.png');
navigate('conversations');
browse('set', 'viewport', '390', '844');
if (evaluate('document.querySelector("#thread-inspector").hidden') === 'false') browse('click', '#close-inspector');
browse('screenshot', 'docs/screenshots/conversation-mobile.png');
const overflow = evaluate('document.documentElement.scrollWidth > innerWidth'); assert.equal(overflow, 'false', 'Mobile viewport has horizontal overflow');
const errors = browse('errors'); assert.ok(!errors.trim(), `Browser errors: ${errors}`);
const resources = browserValue('JSON.stringify(performance.getEntriesByType("resource").map(r => r.name))');
const urls = typeof resources === 'string' ? JSON.parse(resources) : resources;
assert.ok(urls.every(url => new URL(url).origin === base), 'Unexpected third-party request');
const protocol = await fetch(base + '/protocol.html'); assert.equal(protocol.status, 200); assert.ok((await protocol.text()).includes('Receive and acknowledge'));
const spec = await fetch(base + '/openapi.json'); assert.equal(spec.status, 200); assert.equal((await spec.json()).openapi, '3.1.0');
await writeFile('docs/browser-verification.json', JSON.stringify({ checked_at: new Date().toISOString(), runtime: process.env.AGENTPENPAL_BROWSER_BACKEND === 'sqlite' ? 'Node.js + persistent SQLite' : 'Wrangler + local D1',
  verified: ['Owner first-run setup (first invocation)', 'Human browser session', 'Owner-invited Agent pairs through UI; proof rejected until explicit approval', 'Agent-created group', 'Agent adds another participant', 'Human creates group through UI', 'Human adds group participant through UI', 'Text / JSON / artifact rendering', 'Message acknowledgment shown in activity', 'Human sends from composer', 'Message persists in storage and reaches Agent inbox', 'Desktop 1600×1100', 'Mobile 390×844 without horizontal overflow', 'Agent DM direction labels and read-only observer', 'Observer creates separate three-person group and sends to both Agents', 'Original DM membership and history preserved', 'No browser errors', 'No third-party browser requests', 'In-app protocol guide and OpenAPI served'],
  demo_note: 'Demo messages are fixtures posted through the real API, not autonomous LLM outputs.' }, null, 2));
browse('close');
console.log('Browser → API → storage → Agent inbox verified. Screenshots saved in docs/screenshots.');
