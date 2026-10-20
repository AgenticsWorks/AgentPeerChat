// Real UI + API + D1 demonstration. Run only against a local, disposable instance.
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const base = (process.env.AGENTPEERCHAT_TEST_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname)) throw new Error('Browser fixture tests require a disposable loopback instance.');
const browser = './node_modules/.bin/agent-browser';
function browse(...args) {
  const r = spawnSync(browser, ['--session', process.env.AGENTPEERCHAT_BROWSER_SESSION ?? 'agentpeerchat-verification', ...args], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || 'Browser command failed');
  return r.stdout.trim();
}
function navigate(view) { browse('click', '#menu-toggle'); browse('click', `#main-menu [data-view="${view}"]`); }
function evaluate(code) { return browse('eval', code); }
function browserValue(code) { return JSON.parse(evaluate(code)); }
async function waitFor(selector) { browse('wait', selector); }
async function api(path, key, method = 'GET', data, send = false) {
  // Synchronous browser commands can outlive HTTP keep-alive while blocking Node's event loop.
  const r = await fetch(base + '/api/v1' + path, { method, headers: { Connection:'close', ...(key ? { Authorization: `Bearer ${key}` } : {}),
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
  for (const width of [320,375,390,430,768,1600]) {
    browse('set','viewport',String(width),'844');
    assert.equal(browserValue('document.documentElement.scrollWidth > innerWidth'),false,'Setup must fit viewport '+width);
    assert.ok(browserValue('document.querySelector("#auth-submit").getBoundingClientRect().right <= innerWidth'),'Setup button must remain visible');
    if(width<=430)assert.ok(browserValue('document.querySelector("#auth-submit").getBoundingClientRect().bottom <= innerHeight'),'Primary setup action must fit the first phone screen');
  }
  browse('set','viewport','390','844');
  browse('fill','#auth-name','Phone owner');browse('fill','#auth-key','wrong-setup-secret');browse('click','#auth-submit');
  browse('wait','--fn','document.querySelector("#auth-error").textContent.length > 0');
  assert.match(browserValue('document.querySelector("#auth-error").textContent'),/does not match/);
  assert.equal((await api('/status')).initialized,false,'Wrong secret cannot create an owner');
  assert.equal(browserValue('document.querySelector("#setup-help").open'),true);
  evaluate('navigator.clipboard.writeText=async value=>{window.setupRequest=value}');browse('click','#copy-setup-help');
  const request=browserValue('window.setupRequest');assert.ok(request.includes(base));assert.ok(request.includes('deployment-secrets.json'));assert.ok(!request.includes(secret));assert.ok(!request.includes('wrong-setup-secret'));
  evaluate('navigator.clipboard.writeText=async()=>{throw new Error("Clipboard denied")}');browse('click','#copy-setup-help');await waitFor('#field-secret');
  assert.equal(browserValue('document.querySelector("#field-secret").value'),request);browse('click','#modal-submit');
  browse('select','[data-language-switch]','zh');
  assert.match(browserValue('document.querySelector("#auth-name-hint").textContent'),/显示名字/);
  assert.equal(browserValue('document.documentElement.scrollWidth > innerWidth'),false,'Chinese setup help must fit phone');
  browse('screenshot','docs/screenshots/setup-mobile-zh.png');
  browse('select','[data-language-switch]','en');browse('screenshot','docs/screenshots/setup-mobile-en.png');
  browse('fill', '#auth-name', 'Alex'); browse('fill', '#auth-key', '  '+secret+'  '); browse('click', '#auth-submit');
  browse('wait','--fn','document.querySelector("#modal").open || (!document.querySelector("#auth-submit").disabled && document.querySelector("#auth-error").textContent.length > 0)');
  assert.equal(browserValue('document.querySelector("#auth-error").textContent'),'','Correct setup secret must create owner');
  await waitFor('#field-secret');
  const key = browserValue('document.querySelector("#field-secret").value');
  credentials = { owner: key };
  await writeFile('.wrangler/demo-secrets.json', JSON.stringify(credentials), { mode: 0o600 });
  browse('click', '#modal-submit'); await waitFor('#shell:not([hidden])');
} else {
  credentials = JSON.parse(await readFile('.wrangler/demo-secrets.json', 'utf8'));
  browse('wait', '--fn', '!document.querySelector("#shell").hidden || !document.querySelector("#onboarding").hidden');
  if (evaluate('document.querySelector("#shell").hidden') === 'true') {
    browse('fill', '#auth-key', credentials.owner); browse('click', '#auth-submit'); await waitFor('#shell:not([hidden])');
  }
}
// An agent-assisted deployment hands the owner a private fragment link, avoiding setup/key forms.
evaluate('fetch("/api/v1/session",{method:"DELETE",credentials:"same-origin"})');
browse('open',base+'/#access_key='+encodeURIComponent(credentials.owner));browse('wait','--fn','location.hash === "" && !document.querySelector("#shell").hidden');
assert.equal(browserValue('location.hash'),'','Sign-in credentials must be removed from browser history');
const me = (await api('/me', credentials.owner)).principal;
if (!credentials.group) {
  // Create an unnamed agent through the current product UI.
  browse('click', '#connect-agent-button'); await waitFor('#field-name');
  assert.equal(browserValue('document.querySelector("#field-name").required'),false);
  browse('click', '#modal-submit'); await waitFor('#field-secret');
  const packet = browserValue('document.querySelector("#field-secret").value');
  const connection = JSON.parse(packet.match(/AGENTPEERCHAT_CONFIG_JSON'\n([\s\S]*?)\nAGENTPEERCHAT_CONFIG_JSON/)[1]);
  assert.equal(connection.register_name,true); assert.ok(packet.includes('agentpeerchat join --no-wait'));
  assert.equal(connection.receiving.mode,'auto');
  assert.ok(!connection.token);assert.ok(connection.pairing.code);
  assert.equal(connection.pairing.approval_required,false);
  const key = 'agt_'+randomUUID().replaceAll('-','');
  const requested=await api('/pairings/request',null,'POST',{code:connection.pairing.code,token_hash:createHash('sha256').update(key).digest('hex')});
  assert.equal(requested.pairing.status,'approved');
  browse('click', '#modal-submit');
  await api('/me',key,'PATCH',{name:'Codex'});
  const agent = (await api('/me', key)).principal; credentials.codex = { id: agent.id, key };
  for (const [name, description, field] of [['Researcher', 'Finds the evidence behind every decision', 'researcher']]) {
    const r = await api('/agents', credentials.owner, 'POST', { name, description }); credentials[field] = { id: r.principal.id, key: r.token.token };
  }
  // Approval is optional now; explicitly request it to retain coverage of the approval UI.
  const invitation=await api('/pairings',credentials.owner,'POST',{name:'Reviewer',approval_required:true});
  const reviewerKey='agt_'+randomUUID().replaceAll('-','');
  const pending=await api('/pairings/request',null,'POST',{code:invitation.pairing.code,token_hash:createHash('sha256').update(reviewerKey).digest('hex')});
  const unauthorized=await fetch(base+'/api/v1/me',{headers:{Connection:'close',Authorization:'Bearer '+reviewerKey}});assert.equal(unauthorized.status,401);
  browse('open',base);await waitFor('#pairing-list .pairing-request');
  assert.ok(browserValue('document.querySelector("#pairing-list").textContent').includes(pending.pairing.verification_code));
  browse('click','#pairing-list .primary');
  browse('wait','--fn','document.querySelector("#pairing-requests").hidden');
  credentials.reviewer={id:(await api('/me',reviewerKey)).principal.id,key:reviewerKey};
  const group = await api('/threads', credentials.codex.key, 'POST', { title: 'AgentPeerChat · Launch crew', members: [credentials.researcher.id, me.id] });
  credentials.group = group.thread.id;
  // Agent proactively adds another agent after creating the group.
  await api(`/threads/${credentials.group}/members`, credentials.codex.key, 'POST', { members: [credentials.reviewer.id] });
  const send = async (actor, type, content) => (await api('/messages', actor, 'POST', { thread_id: credentials.group, type, content }, true)).message;
  const start = await send(credentials.codex.key, 'text', 'I’ve created this group for our launch.\n\nResearcher — check the deployment story. Reviewer — review the first-run experience. I’ll bring the implementation together.');
  await api(`/messages/${start.id}/ack`, credentials.researcher.key, 'POST'); await api(`/messages/${start.id}/ack`, credentials.reviewer.key, 'POST');
  const brief = await send(credentials.researcher.key, 'json', { status: 'Research complete', finding: 'One Worker + one D1. Everything belongs to the user’s Cloudflare account.', next_step: 'Keep the first release focused on reliable async handoffs.' });
  await api(`/messages/${brief.id}/ack`, credentials.codex.key, 'POST');
  await send(credentials.reviewer.key, 'text', 'The group flow feels familiar. I’d make pending vs. acknowledged visible beside every handoff, so people can follow the work without reading API logs.');
  await send(credentials.codex.key, 'artifact', { name: 'First-run experience · design notes', url: 'https://example.com/agentpeerchat/design-notes' });
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
browse('find', 'text', 'AgentPeerChat · Launch crew', 'click'); await waitFor('[data-message-id]');
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
const humanMessage=messages.find(m=>m.sender_id===me.id&&m.content===unique);
// Simulate visibility/connectivity events deterministically in the real page.
// API writes must appear without reloading or waiting for the 30-second poll.
browse('wait','--fn','document.querySelector("#sync-state").textContent.startsWith("Last synced ")');
evaluate('window.resumeTestPage = true; Object.defineProperty(document, "hidden", {configurable:true, value:true}); document.dispatchEvent(new Event("visibilitychange"))');
assert.equal(browserValue('document.querySelector("#sync-state").textContent'),'Sync paused');
const reply='I will retain owner confirmation before publishing and calculate the daily request budget for this plan.';
const agentReply=await api('/messages',credentials.codex.key,'POST',{thread_id:smoke.id,type:'text',content:reply},true);
await api('/messages/'+humanMessage.id+'/ack',credentials.codex.key,'POST');
assert.equal(browserValue(`document.querySelector('#message-list').textContent.includes(${JSON.stringify(reply)})`),false);
const resumedAt=Date.now();
evaluate('delete document.hidden; document.dispatchEvent(new Event("visibilitychange"))');
browse('wait','--fn',`document.querySelector('#message-list').textContent.includes(${JSON.stringify(reply)})`);
assert.ok(Date.now()-resumedAt<10000,'Tab resume should refresh well before the 30-second poll');
assert.equal(browserValue('window.resumeTestPage'),true,'The page must not reload to see replies');
assert.equal(browserValue(`document.querySelectorAll('[data-message-id="${agentReply.message.id}"]').length`),1);
assert.ok((await api('/messages/'+humanMessage.id,credentials.owner)).receipts.some(r=>r.recipient_id===credentials.codex.id&&r.acked_at));
browse('click',`[data-message-id="${humanMessage.id}"] .receipt-button`);
await waitFor('#modal[open]');
assert.match(browserValue('document.querySelector("#modal-fields").textContent'),/Codex: Acknowledged/);
browse('click','#modal-submit');
browse('wait','--fn','document.querySelector("#sync-state").textContent.startsWith("Last synced ")');
evaluate('Object.defineProperty(navigator, "onLine", {configurable:true, value:false}); window.dispatchEvent(new Event("offline"))');
assert.equal(browserValue('document.querySelector("#sync-state").textContent'),'Offline');
const reconnectReply=await api('/messages',credentials.codex.key,'POST',{thread_id:smoke.id,type:'text',content:'Network recovery verification'},true);
const reconnectedAt=Date.now();
evaluate('delete navigator.onLine; window.dispatchEvent(new Event("online"))');
browse('wait','--fn',`document.querySelectorAll('[data-message-id="${reconnectReply.message.id}"]').length === 1`);
assert.ok(Date.now()-reconnectedAt<10000,'Network recovery should refresh well before the 30-second poll');
browse('wait','--fn','document.querySelector("#sync-state").textContent.startsWith("Last synced ")');
browse('select','[data-language-switch]','zh');
assert.match(browserValue('document.querySelector("#sync-state").textContent'),/^上次同步 /);
browse('select','[data-language-switch]','en');
assert.match(browserValue('document.querySelector("#sync-state").textContent'),/^Last synced /);

browse('find', 'text', 'AgentPeerChat · Launch crew', 'click'); await waitFor('[data-message-id]');
evaluate('document.querySelector("#message-list").scrollTop = 0');
browse('screenshot', 'docs/screenshots/conversation-desktop.png');
// Observer cannot write into an Agent-only DM. Joining creates a separate group.
const dm = await api('/threads', credentials.codex.key, 'POST', {kind:'direct',members:[credentials.researcher.id]});
await api('/messages',credentials.codex.key,'POST',{thread_id:dm.thread.id,type:'text',content:'Compare the deployment options and check the daily request budget.'},true);
browse('open',base);await waitFor('#shell:not([hidden])');
browse('wait','--fn',`Array.from(document.querySelectorAll('.thread-item')).some(b => b.textContent.includes('Compare the deployment options'))`);
browse('find','text','Compare the deployment options','click');await waitFor('#observe-actions:not([hidden])');
assert.equal(browserValue('document.querySelector("#message-text").disabled'),true);
assert.equal(browserValue('document.querySelector(".message-meta strong").textContent'),'Codex');
assert.equal(browserValue('document.querySelector(".message-target").textContent'),'→ Researcher');
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
browse('select','#identity-perspective',credentials.codex.id);await waitFor('#observe-actions:not([hidden])');
assert.equal(browserValue('document.querySelector("#message-text").disabled'),true);
assert.equal(browserValue('document.querySelector("#join-discussion").hidden'),true);
assert.equal(browserValue('document.querySelector("#my-name").textContent'),me.name);
browse('select','#identity-perspective','all');await waitFor('#compose-form:not([hidden])');
assert.equal(browserValue('document.querySelector("#message-text").disabled'),false);

navigate('graph');await waitFor('#conversation-graph canvas');assert.ok(browserValue('document.querySelector("#graph-summary").textContent').length);browse('click','#graph-zoom-in');browse('click','#graph-fit');browse('screenshot','docs/screenshots/graph-desktop.png');
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
const protocol = await fetch(base + '/protocol.html',{headers:{Connection:'close'}}); assert.equal(protocol.status, 200); assert.ok((await protocol.text()).includes('Receive and acknowledge'));
const spec = await fetch(base + '/openapi.json',{headers:{Connection:'close'}}); assert.equal(spec.status, 200); assert.equal((await spec.json()).openapi, '3.1.0');
await writeFile('docs/browser-verification.json', JSON.stringify({ checked_at: new Date().toISOString(), runtime: process.env.AGENTPEERCHAT_BROWSER_BACKEND === 'sqlite' ? 'Node.js + persistent SQLite' : 'Wrangler + local D1',
  verified: ['Owner first-run setup (first invocation)', 'Setup at 320/375/390/430/768/1600px without horizontal overflow', 'Wrong initialization secret rejected without creating an owner', 'Initialization help and Chinese/English field explanations', 'Agent setup request excludes entered and configured secrets', 'Clipboard success and denied-permission manual-copy fallback', 'Whitespace around copied setup secret is trimmed before initialization', 'Human browser session', 'Owner-invited Agent pairs through UI; proof rejected until explicit approval', 'Agent-created group', 'Agent adds another participant', 'Human creates group through UI', 'Human adds group participant through UI', 'Text / JSON / artifact rendering', 'Message acknowledgment shown in activity', 'Human sends from composer', 'Message persists in storage and reaches Agent inbox', 'Agent API reply renders in the browser and processed message has an acknowledgment receipt', 'Conversation graph renders with working zoom and fit controls', 'Desktop 1600×1100', 'Mobile 390×844 without horizontal overflow', 'Agent DM direction labels and read-only observer', 'Observer creates separate three-person group and sends to both Agents', 'Original DM membership and history preserved', 'Agent perspective is read-only and never changes the signed-in owner identity', 'No browser errors', 'No third-party browser requests', 'In-app protocol guide and OpenAPI served'],
  demo_note: 'Demo messages are fixtures posted through the real API, not autonomous LLM outputs.' }, null, 2));
browse('close');
console.log('Browser → API → storage → Agent inbox verified. Screenshots saved in docs/screenshots.');
