import {t, initLanguage, getLocale} from './i18n.js';
import { chatName, messageDirection } from './chat-presentation.js';
import { threadPeople, visibleThreads, conversationGraph, isDisabled, avatarIcon } from './conversation-view.js';
import { renderConversationGraph } from './conversation-graph.js';
import { connectionInstructions } from './connection-kit.js';
import { createChatSync } from './chat-sync.js';
import { createReceivingPage } from './receiving-status.js';
initLanguage();
const $ = selector => document.querySelector(selector);
const appBase = document.querySelector('meta[name="agentpeerchat-base"]')?.content ?? document.querySelector('meta[name="agentgram-base"]')?.content ?? '';
const state = { me: null, principals: [], threads: [], selected: null, messages: [], members: [], cursor: '0', view: 'conversations', authMode: 'login', modalAction: null, secretOpen: false, inspector: window.matchMedia('(min-width: 1280px)').matches, currentThread: null, perspective: 'all', inviteCode: null, pendingThread: null, receiptCounts: new Map(), receivingCheckedAt: 0 };
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const avatarColors = ['#a45767', '#547767', '#526c9c', '#7861a0', '#916c43', '#477e85'];
function colorAvatar(node, name) { node.style.background = avatarColors[Array.from(name).reduce((n, c) => n + c.codePointAt(0), 0) % avatarColors.length]; }
function toggleMenu(open) { const wasOpen = !$('#main-menu').hidden; $('#main-menu').hidden = !open; $('#menu-backdrop').hidden = !open; $('#menu-toggle').setAttribute('aria-expanded', String(open)); if (open) $('#main-menu [data-view]').focus(); else if (wasOpen) $('#menu-toggle').focus(); }
$('#menu-toggle').addEventListener('click', () => toggleMenu($('#main-menu').hidden));
$('#menu-backdrop').addEventListener('click', () => toggleMenu(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape') { if (!$('#main-menu').hidden) toggleMenu(false); if (state.inspector) { state.inspector = false; renderMembers(); } } });
$('#chat-back').addEventListener('click', () => { $('#conversations').classList.remove('chat-open'); state.inspector = false; renderMembers(); });
$('#message-text').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!$('#send-button').disabled) $('#compose-form').requestSubmit(); } });
$('#message-text').addEventListener('input', () => { const input = $('#message-text'); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 150) + 'px'; });
const humanName = id => state.principals.find(p => p.id === id)?.name ?? id;
const time = value => new Date(value).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' });
const date = value => new Date(value).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' });
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
async function api(path, options = {}) {
  const { method = 'GET', data, key } = options;
  const headers = { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) };
  const response = await fetch(`${appBase}/api/v1${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), credentials: 'same-origin' });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error?.message ?? t("Request failed.")); error.status = response.status; throw error; }
  return result;
}
async function allPages(path, initial = '0') {
  const items = []; let cursor = initial, last;
  do { last = await api(`${path}${path.includes('?') ? '&' : '?'}after=${cursor}&limit=100`); items.push(...last.items); cursor = last.next_cursor; } while (last.has_more);
  return { items, next_cursor: cursor, last };
}
function authMode(mode) {
  chatSync.stop();
  receivingPage.reset();
  state.authMode = mode;
  $('.skip-link').href = '#onboarding'; $('#perspective-toolbar').hidden = true; $('#menu-toggle').hidden = true; $('#onboarding').hidden = false; $('#shell').hidden = true; $('#auth-error').textContent = '';
  const setup = mode === 'setup', invite = mode === 'invite';
  $('#onboarding').dataset.mode = mode;
  $('#setup-help').hidden = !setup; $('#setup-key-hint').hidden = !setup;
  $('#key-help').hidden = mode !== 'login'; renderKeyHelp();
  $('#auth-kicker').textContent = setup ? t("MAKE IT YOURS") : invite ? t("YOU’RE INVITED") : t("WELCOME HOME");
  $('#auth-title').textContent = setup ? t("Create your private network") : invite ? t("Join the conversation") : t("Open your network");
  $('#auth-description').textContent = setup ? t("Use the setup secret from your deployment to create the owner.") : invite ? t("Redeem a one-time invitation to join as a human.") : t("Ask your connected Agent for a link. Your existing pairing is remembered.");
  $('#auth-form').hidden = mode === 'login'; $('#recovery-toggle').hidden = mode !== 'login';
  $('#recovery-toggle').textContent = t("Use a recovery key instead");
  $('#name-label').hidden = !(setup || invite); $('#auth-name').required = setup || invite;
  $('#key-label').textContent = setup ? t("Setup secret") : invite ? t("Invitation code") : t("Access key");
  $('#auth-key').placeholder = setup ? t("Your deployment setup secret") : invite ? 'agi_…' : 'agt_…';
  $('#auth-submit').textContent = setup ? t("Create network →") : invite ? t("Accept invitation →") : t("Open network →");
  $('#auth-switch').hidden = setup; $('#auth-switch').textContent = invite ? t("I already have an access key") : t("I have an invitation");
}
// The paired Agent is the normal entry point. Manual key recovery is secondary.
function renderKeyHelp() {
  const body = $('#key-help-body'); if (!body) return;
  body.replaceChildren();
  const request=t("Open my AgentPeerChat workspace. Run agentpeerchat web --login using your existing saved identity and send me the returned link privately. Do not pair again or ask me for an API key. My instance is {0}; verify it matches your saved connection. If your CLI lacks this command, update it from {0}/agentpeerchat-cli.tgz while preserving your saved configuration.", location.origin+appBase);
  body.append(el('p', '', t("Grok Bot, Muse, Dots or any connected personal Agent can open this workspace for you.")));
  const copy=el('button','primary',t("Copy request for my Agent"));copy.type='button';copy.id='copy-login-request';
  const status=el('p','fine');status.id='login-copy-status';status.setAttribute('role','status');
  copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(request);status.textContent=t("Copied. Send it to your connected Agent, then open the link it returns.");}catch{await showSecret(t("Open my workspace"),t("Send this request to your connected Agent. It contains no key."),request);}});
  body.append(copy,status,el('p','fine',t("Connect once. Your Agent keeps its identity, and this browser remembers sign-in.")));
}
$('#recovery-toggle').addEventListener('click',()=>{const form=$('#auth-form');form.hidden=!form.hidden;$('#recovery-toggle').textContent=form.hidden?t("Use a recovery key instead"):t("Hide recovery key");if(!form.hidden)$('#auth-key').focus();});
$('#auth-switch').addEventListener('click', () => authMode(state.authMode === 'invite' ? 'login' : 'invite'));
$('#copy-setup-help').addEventListener('click', async () => {
  const request = t("Find the initialization secret for my instance at {0}. Verify this URL matches the instance you deployed. Read the SETUP_SECRET value from that deployment's .wrangler/deployment-secrets.json, or use the initialization secret you configured. I authorize you to send only this initialization secret to me privately so I can paste it into the setup page on my phone. Finding the file path alone is not enough. Keep Cloudflare API tokens and other credentials private. If you cannot access the saved secret, tell me before changing it.", location.origin + appBase);
  try { await navigator.clipboard.writeText(request); $('#setup-copy-status').textContent = t("Copied. Send this request to the agent that deployed your instance."); }
  catch { await showSecret(t("Setup request"), t("Copy this request to the agent that deployed your instance. It contains no secret."), request); }
});
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#auth-error').textContent = ''; $('#auth-submit').disabled = true;
  try {
    let accessKey = $('#auth-key').value.trim();
    if (state.authMode === 'setup' || state.authMode === 'invite') {
      const name = $('#auth-name').value.trim();
      const result = await api(state.authMode === 'setup' ? '/setup' : '/invites/redeem', {
        method: 'POST', data: state.authMode === 'setup' ? { name, setup_secret: accessKey } : { name, code: accessKey }
      });
      accessKey = result.access_key;
      await showSecret(t("Save your access key"), t("This is your sign-in key. Save it in a password manager; it is shown only once."), accessKey);
    }
    await api('/session', { method: 'POST', data: { access_key: accessKey } });
    $('#auth-key').value = ''; await enter();
  } catch (error) {
    $('#auth-error').textContent = state.authMode === 'setup' && error.status === 403 ? t("The initialization secret does not match this instance. Use the saved SETUP_SECRET, not a Cloudflare password or API token. Open the help below or ask your deployment agent.") : error.message;
    if (state.authMode === 'setup') $('#setup-help').open = true;
  }
  finally { $('#auth-submit').disabled = false; }
});

function openModal(title, description, action) {
  $('#modal-title').textContent = title; $('#modal-description').textContent = description;
  $('#modal-fields').replaceChildren(); $('#modal-error').textContent = ''; $('#modal-submit').textContent = t("Create");
  $('#modal-submit').disabled = false; state.modalAction = action; state.secretOpen = false;
  $('#modal').showModal();
}
function field(label, name, placeholder = '', tag = 'input') {
  const wrapper = el('label', '', label), input = el(tag);
  input.name = name; input.id = `field-${name}`; input.placeholder = placeholder; input.required = true; input.maxLength = name === 'description' ? 500 : 120;
  wrapper.append(input); $('#modal-fields').append(wrapper); return input;
}
function closeModal() { state.secretOpen=false; $('#modal').close(); const resolve=state.secretResolve; state.secretResolve=null; resolve?.(); }
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
$('#modal-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#modal-error').textContent = ''; $('#modal-submit').disabled = true;
  const action = state.modalAction;
  try { await action(new FormData(event.target)); }
  catch (error) { $('#modal-error').textContent = error.message; }
  finally { $('#modal-submit').disabled = false; }
});
function showSecret(title, description, value, extra = '', options = {}) {
  return new Promise(resolve => {
    // Finish the current form submission before reusing its dialog.
    $('#modal').close();
    openModal(title, description, async () => {
      closeModal();
    });
    state.secretOpen = true; state.secretResolve=resolve;
    const box = field(t("接入指令"), 'secret', '', 'textarea'); box.value = value; box.readOnly = true; box.className = options.copyLabel ? 'secret-box connection-box' : 'secret-box';
    const copy = el('button', 'secondary', options.copyLabel ?? t("Copy to clipboard")); copy.type = 'button';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(box.value); toast(options.copyLabel ? t("接入指令已复制，可以交给对应 Agent。") : t("Copied. Save it somewhere safe.")); if(options.finishOnCopy){closeModal();} } catch { box.select(); toast(t("Select and copy the key manually.")); } });
    $('#modal-fields').append(copy);
    if (extra) $('#modal-fields').append(el('p', 'key-hint', extra));
    $('#modal-submit').textContent = t("完成");
  });
}

async function enter() {
  state.me = (await api('/me')).principal; $('.skip-link').href = '#conversations';
  $('#onboarding').hidden = true; $('#shell').hidden = false; state.perspective = 'all'; $('#perspective-toolbar').hidden = false; $('#menu-toggle').hidden = false;
  $('#my-name').textContent = state.me.name; $('#my-role').textContent = state.me.kind === 'owner' ? t("拥有者") : t("联系人");
  $('#my-avatar').textContent = state.me.name.slice(0, 1).toUpperCase(); $('#composer-name').textContent = state.me.name;
  document.querySelectorAll('.owner-only').forEach(node => { node.hidden = state.me.kind !== 'owner'; });
  if (state.view === 'receiving' && state.me.kind !== 'owner') showView('conversations');
  await chatSync.start();
  if (state.view === 'receiving' && state.me.kind === 'owner') receivingPage.start();
  await consumePendingThread();
}
// A deep link (#thread=…) survives manual sign-in: the target is held until a session exists.
async function consumePendingThread() {
  const target = state.pendingThread; if (!target) return;
  state.pendingThread = null;
  showView('conversations');
  await selectThread(target);
}
async function refreshData(isCurrent) {
  const principals = (await api('/principals')).items;
  if (!isCurrent()) return;
  const threads = (await allPages('/threads')).items;
  if (!isCurrent()) return;
  state.principals = principals; state.threads = threads;
  renderPerspective(); renderThreads(); renderPrincipals(); renderGraph();
  if (state.selected) await loadMessages();
  if (isCurrent() && state.me.kind === 'owner') await renderPairings();
}
function renderSyncState({ status, lastSyncedAt }) {
  const node = $('#sync-state');
  const labels = { idle: '', syncing: t('Syncing…'), paused: t('Sync paused'), offline: t('Offline'), retrying: t('Sync paused · retrying') };
  node.textContent = status === 'synced'
    ? t('Last synced {0}', new Date(lastSyncedAt).toLocaleTimeString(getLocale()))
    : labels[status];
  node.title = lastSyncedAt === null ? '' : t('Last synced {0}', new Date(lastSyncedAt).toLocaleString(getLocale()));
  node.classList.toggle('sync-warning', status === 'offline' || status === 'retrying');
}
const chatSync = createChatSync({
  refresh: refreshData, onState: renderSyncState,
  onUnauthorized: () => { state.me = null; authMode('login'); toast(t("Session ended. Sign in again.")); }
});
const receivingPage = createReceivingPage({ root: $('#receiving'), api, t, locale: getLocale,
  avatar: p => personAvatar(state.principals.find(person => person.id === p.id) ?? p),
  onUnauthorized: () => { state.me = null; authMode('login'); toast(t('Session ended. Sign in again.')); },
  openConversation: async p => {
    const id = p.oldest_pending?.thread_id ?? state.threads.find(thread => thread.kind === 'direct' && threadPeople(thread).some(person => person.id === p.id) && threadPeople(thread).some(person => person.id === state.me.id))?.id;
    if (!id) { toast(t('No direct conversation with this Agent yet.')); return; }
    showView('conversations'); await selectThread(id);
  }
});
function refresh() { return chatSync.refresh(); }
document.addEventListener('visibilitychange', chatSync.availabilityChanged);
document.addEventListener('visibilitychange', receivingPage.availabilityChanged);
window.addEventListener('online', receivingPage.availabilityChanged);
window.addEventListener('offline', receivingPage.availabilityChanged);
window.addEventListener('online', chatSync.availabilityChanged);
window.addEventListener('offline', chatSync.availabilityChanged);
$('#logout').addEventListener('click', async () => {
  try { await api('/session', { method: 'DELETE' }); state.me = null; state.selected = null; state.messages = []; $('#chat-empty').hidden = false; $('#chat-active').hidden = true; authMode('login'); } catch (error) { toast(error.message); }
});
function showView(view) {
  if (view === 'receiving' && state.me?.kind !== 'owner') return;
  state.view = view; $('.skip-link').href = `#${view}`; toggleMenu(false);
  for (const name of ['conversations', 'network', 'access', 'graph', 'receiving']) $(`#${name}`).hidden = name !== view;
  document.querySelectorAll('[data-view]').forEach(button => { const active = button.dataset.view === view; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); });
  if (view === 'graph') renderGraph();
  if (view === 'access') loadAccess().catch(error => toast(error.message));
  if (view === 'receiving') receivingPage.start(); else receivingPage.stop();
}
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
$('#thread-search').addEventListener('input', renderThreads);
function renderThreads() {
  $('#thread-count').textContent = String(state.threads.length);
  const scope = visibleThreads(state.threads, state.perspective);
  $('#thread-count').textContent = String(scope.length);
  const filtered = scope.filter(thread => chatName(thread, state.perspective === 'all' ? null : state.perspective).toLowerCase().includes($('#thread-search').value.toLowerCase()));
  $('#thread-list').replaceChildren();
  if (!filtered.length) $('#thread-list').append(el('p', 'empty-list', state.threads.length ? t("没有找到聊天。") : t("选择联系人，开始第一段聊天。")));
  for (const thread of [...filtered].sort((a, b) => (b.last_message_seq ?? 0) - (a.last_message_seq ?? 0))) {
    const button = el('button', 'thread-item'); button.classList.toggle('selected', thread.id === state.selected); button.setAttribute('aria-current', thread.id === state.selected ? 'true' : 'false');
    const copy = el('div', 'thread-copy');
    const last = thread.last_message;
    const preview = !last ? t("还没有消息") : last.type === 'text' ? last.content : last.type === 'artifact' ? `↗ ${last.content.name ?? 'Deliverable'}` : last.type === 'json' ? t("内容") : last.content;
    copy.append(el('strong', '', chatName(thread, state.perspective === 'all' ? null : state.perspective)), el('small', '', last ? `${messageDirection(thread, last.sender_id, humanName(last.sender_id))}: ${preview}` : preview));
    const avatar = conversationAvatar(thread);
    const kind = el('span', 'conversation-kind', thread.kind === 'direct' ? t('Direct chat') : t('Group chat'));
    copy.prepend(kind);
    button.append(avatar, copy, el('time', '', last?.created_at ? time(last.created_at) : date(thread.created_at)));
    button.addEventListener('click', () => selectThread(thread.id)); $('#thread-list').append(button);
  }
}
async function selectThread(threadId) {
  $('#conversations').classList.add('chat-open');
  state.selected = threadId; state.currentThread = null; state.messages = []; state.cursor = '0'; state.receiptCounts.clear(); state.receivingCheckedAt = 0; $('#chat-receiving').textContent = '';
  $('#observe-actions').hidden = true; $('#message-text').disabled = true; $('#send-button').disabled = true;
  $('#compose-error').textContent = ''; $('#message-text').value = ''; $('#compose-form').dataset.pendingKey = ''; $('#compose-form').dataset.pendingSignature = '';
  $('#chat-empty').hidden = true; $('#chat-active').hidden = false; $('#chat-title').textContent = t('Loading conversation…'); $('#chat-members').textContent = ''; renderThreads(); $('#message-list').replaceChildren(el('p', 'empty-list', t('Loading messages…'))); $('#message-list').setAttribute('aria-busy', 'true');
  try { await loadMessages(true); } catch (error) { if (state.selected === threadId) { $('#message-list').replaceChildren(el('p', 'empty-list error', t('Could not load this conversation. Select it again to retry.'))); toast(error.message); } } finally { if (state.selected === threadId) $('#message-list').setAttribute('aria-busy', 'false'); }
}
async function loadMessages(forceScroll = false) {
  const threadId = state.selected, cursor = state.cursor, me = state.me;
  const result = await allPages(`/threads/${threadId}`, cursor);
  if (state.me !== me || state.selected !== threadId || state.cursor !== cursor) return;
  $('#chat-title').textContent = chatName(result.last.thread, state.perspective === 'all' ? null : state.perspective);
  $('#chat-members').textContent = conversationSubtitle(result.last.thread);
  $('#chat-avatar').replaceChildren(...conversationAvatar(result.last.thread).childNodes); $('#chat-avatar').className = conversationAvatar(result.last.thread).className;
  state.members = result.last.thread.members; state.currentThread = result.last.thread;
  const observing = result.last.thread.kind === 'direct' && !state.members.some(p => p.id === state.me.id);
  const perspectiveOnly = state.perspective !== 'all';
  $('#observe-actions').hidden = !observing; $('#compose-form').hidden = observing || perspectiveOnly;
  $('#message-text').disabled = observing || perspectiveOnly; $('#send-button').disabled = observing || perspectiveOnly;
  $('#observe-actions').hidden = !(observing || perspectiveOnly);
  $('#observe-actions span').textContent = perspectiveOnly ? t('Viewing as {0} · Read only', humanName(state.perspective)) : t('Viewing an agent direct chat · Original conversation preserved');
  $('#join-discussion').hidden = perspectiveOnly;
  $('#message-text').placeholder = observing ? t("正在查看这段私聊") : t("消息");
  $('#add-members').hidden = result.last.thread.kind === 'direct';
  renderMembers();
  if (result.items.length || forceScroll) {
    state.messages.push(...result.items); state.cursor = result.next_cursor;
    renderMessages(forceScroll);
  }
  await Promise.all([loadActivity(threadId), loadReceiving(threadId)]);
}
$('#join-discussion').addEventListener('click', async () => {
  const source = state.currentThread;
  if (!source || source.kind !== 'direct' || source.members.some(p => p.id === state.me.id)) return;
  const button = $('#join-discussion'); button.disabled = true;
  try {
    const result = await api('/threads', { method: 'POST', data: {
      title: t("{0} · 一起聊", source.members.map(p => p.name).join(', ')).slice(0, 120),
      members: source.members.map(p => p.id)
    } });
    await refresh(); await selectThread(result.thread.id);
    toast(t("已邀请你和两位联系人进入新群，原私聊保留。"));
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
function renderMembers() {
  $('#thread-inspector').hidden = !state.selected || !state.inspector;
  $('#toggle-activity').setAttribute('aria-expanded', String(state.inspector)); $('#group-info').setAttribute('aria-expanded', String(state.inspector));
  $('#inspector-member-list').replaceChildren();
  for (const p of state.members) {
    const row = el('div', 'member-row'), summary = el('div');
    summary.append(el('strong', '', p.name), el('small', '', p.kind === 'agent' ? p.description || 'Agent' : p.kind === 'owner' ? t("拥有者") : t("联系人")));
    row.append(personAvatar(p), summary);
    if (!p.active) row.append(el('span', 'badge off', 'OFF'));
    $('#inspector-member-list').append(row);
  }
}
async function toggleInspector() { state.inspector = !state.inspector; renderMembers(); if (state.inspector && state.selected) try { await loadActivity(state.selected); } catch (error) { toast(error.message); } }
$('#toggle-activity').addEventListener('click', toggleInspector); $('#group-info').addEventListener('click', toggleInspector); $('#close-inspector').addEventListener('click', () => { state.inspector = false; renderMembers(); });
async function loadActivity(threadId) {
  const me = state.me;
  const activity = (await api(`/threads/${threadId}/activity`)).items;
  if (state.me !== me || state.selected !== threadId) return;
  for (const item of activity) {
    const agents = item.recipients.filter(r => state.principals.find(p => p.id === r.recipient_id)?.kind === 'agent');
    const recipients = agents.length ? agents : item.recipients;
    state.receiptCounts.set(item.message_id, { total: recipients.length, processed: recipients.filter(r => r.acked_at).length });
    const button = document.querySelector(`[data-message-id="${item.message_id}"] .receipt-button`);
    if (button) button.textContent = receiptLabel(item.message_id);
  }
  if (!state.inspector) return;
  $('#activity-list').replaceChildren();
  if (!activity.length) $('#activity-list').append(el('p', 'fine', t("还没有消息。")));
  for (const item of activity) {
    const card = el('div', 'activity-card');
    card.append(el('span', 'activity-time', time(item.created_at)), el('strong', '', humanName(item.sender_id)));
    const jump = el('button', 'text-button', t("查看消息"));
    jump.addEventListener('click', () => { const message = $(`[data-message-id="${item.message_id}"]`); if (message) message.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    card.append(jump); $('#activity-list').append(card);
  }
}
$('#add-members').addEventListener('click', () => {
  const choices = state.principals.filter(p => p.active && !state.members.some(m => m.id === p.id));
  if (!choices.length) { toast(t("Everyone in your network is already in this group.")); return; }
  openModal(t("Add to the group"), t("New participants can read the group’s history and receive future messages."), async data => {
    await api(`/threads/${state.selected}/members`, { method: 'POST', data: { members: data.getAll('members') } });
    $('#modal').close(); await loadMessages(); toast(t("Group members updated."));
  });
  const wrapper = el('div', 'check-list');
  for (const p of choices) { const label = el('label'), input = el('input'); input.type = 'checkbox'; input.name = 'members'; input.value = p.id; label.append(input, document.createTextNode(`${p.name} · ${p.kind}`)); wrapper.append(label); }
  $('#modal-fields').append(wrapper); $('#modal-submit').textContent = t("Add participants");
});
function receiptLabel(messageId) {
  const counts = state.receiptCounts.get(messageId);
  if (!counts?.total) return t('Saved · details');
  if (!counts.processed) return t('Saved · awaiting processing');
  if (counts.processed === counts.total) return t('Processed · details');
  return t('Processed {0}/{1} · details', counts.processed, counts.total);
}
async function loadReceiving(threadId) {
  if (Date.now() - state.receivingCheckedAt < 30000) return;
  state.receivingCheckedAt = Date.now();
  const me = state.me;
  try {
    const result = await api(`/threads/${threadId}/receiving`);
    if (state.me !== me || state.selected !== threadId) return;
    $('#chat-receiving').textContent = result.items.length > 1 ? t('{0}/{1} Agent receivers connected', result.items.filter(item => item.connected === true).length, result.items.length) : result.items.map(item => t(item.connected === true
      ? '{0}: receiver connected' : item.connected === false
      ? '{0}: no live receiver · messages stay saved' : '{0}: receiving status unavailable', humanName(item.principal_id))).join(' · ');
    $('#chat-receiving').classList.toggle('receiver-warning', result.items.some(item => item.connected === false));
    $('#chat-receiving').title = t('A connected receiver can wake its runtime. It does not confirm processing. Periodic agents read messages on their next check.');
  } catch {
    if (state.me === me && state.selected === threadId) $('#chat-receiving').textContent = t('Receiving status unavailable · messages stay saved');
  }
}
function renderMessages(forceScroll = false) {
  const list = $('#message-list'), atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  list.replaceChildren();
  if (!state.messages.length) list.append(el('p', 'empty-list', t("A fresh conversation. Send the first message.")));
  let previousDay;
  for (const message of state.messages) {
    const day = new Date(message.created_at).toLocaleDateString(getLocale());
    if (day !== previousDay) { const separator = el('div', 'date-separator'); separator.append(el('span', '', date(message.created_at))); list.append(separator); previousDay = day; }
    const principal = state.principals.find(p => p.id === message.sender_id);
    const article = el('article', `message${message.sender_id === state.perspective ? ' mine' : ''}`);
    article.dataset.messageId = message.id;
    const name = principal?.name ?? message.sender_id;
    article.append(personAvatar(principal ?? {id:message.sender_id,name}));
    const content = el('div', 'message-body'), meta = el('div', 'message-meta');
    meta.append(el('strong', '', name));
    if (principal?.kind === 'agent') meta.append(el('span', 'agent-label', t('Agent')));
    meta.append(el('span', 'message-target', messageDirection(state.currentThread, message.sender_id, name).slice(name.length).trim()));
    const timestamp = el('time', '', time(message.created_at)); timestamp.title = new Date(message.created_at).toLocaleString(getLocale()); timestamp.dateTime = message.created_at;
    const bubble = el('div', 'bubble');
    if (message.type === 'text') bubble.textContent = message.content;
    else if (message.type === 'json') {
      bubble.classList.add('structured-message');
      bubble.append(el('span', 'eyebrow', t("内容")));
      if (message.content && typeof message.content === 'object' && !Array.isArray(message.content)) {
        const rows = el('dl', 'json-fields');
        for (const [key, value] of Object.entries(message.content)) { rows.append(el('dt', '', key.replaceAll('_', ' ')), el('dd', '', typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value))); }
        bubble.append(rows);
      } else bubble.append(el('pre', '', JSON.stringify(message.content, null, 2)));
      const details = el('details'), summary = el('summary', '', t("View raw JSON")); details.append(summary, el('pre', '', JSON.stringify(message.content, null, 2))); bubble.append(details);
    }
    else {
      const link = el('a', '', message.type === 'artifact' ? message.content.name ?? message.content.url : message.content);
      link.href = message.type === 'artifact' ? message.content.url : message.content; link.target = '_blank'; link.rel = 'noopener noreferrer'; bubble.append(link);
      if (message.type === 'artifact') { bubble.classList.add('artifact-message'); bubble.prepend(el('span', 'artifact-icon', '↗'), el('span', 'eyebrow', 'DELIVERABLE')); }
    }
    meta.append(timestamp);
    const footer = el('div', 'message-id');
    const receipts = el('button', 'receipt-button', receiptLabel(message.id)); receipts.type = 'button'; receipts.title = t("消息状态"); receipts.setAttribute('aria-label', t("消息状态"));
    receipts.addEventListener('click', async () => {
      try {
        const result = await api(`/messages/${message.id}`);
        const summary = result.receipts.map(r => `${humanName(r.recipient_id)}: ${r.acked_at ? t("Acknowledged ") + time(r.acked_at) : t("Pending acknowledgment")}`).join('\n');
        openModal(t("消息状态"), t("The message is saved. It shows as processed only after the Agent confirms processing. A connected receiver is not a processing receipt."), async () => { $('#modal').close(); });
        $('#modal-fields').append(el('p', 'key-hint', summary || t("没有收件人。")));
        const mine = result.receipts.find(r => r.recipient_id === state.me.id);
        if (mine && !mine.acked_at) {
          state.modalAction = async () => { await api(`/messages/${message.id}/ack`, { method: 'POST' }); $('#modal').close(); await loadMessages(); toast(t("已标记处理。")); };
          $('#modal-submit').textContent = t("标记已处理");
        } else $('#modal-submit').textContent = t("关闭");
      } catch (error) { toast(error.message); }
    });
    footer.append(receipts); bubble.prepend(meta); bubble.append(footer); content.append(bubble); article.append(content); list.append(article);
  }
  if (atBottom || forceScroll) list.scrollTop = list.scrollHeight;
}
$('#compose-form').addEventListener('submit', async event => {
  event.preventDefault(); const threadId = state.selected, content = $('#message-text').value;
  if (!content.trim() || !threadId || state.perspective !== 'all') return;
  const signature = JSON.stringify({ threadId, content });
  if ($('#compose-form').dataset.pendingSignature !== signature) {
    $('#compose-form').dataset.pendingSignature = signature; $('#compose-form').dataset.pendingKey = crypto.randomUUID();
  }
  $('#send-button').disabled = true; $('#compose-error').textContent = '';
  try {
    await api('/messages', { method: 'POST', data: { thread_id: threadId, type: 'text', content }, key: $('#compose-form').dataset.pendingKey });
    if (state.selected === threadId && $('#message-text').value === content) { $('#message-text').value = ''; $('#message-text').style.height = 'auto'; $('#compose-form').dataset.pendingSignature = ''; }
    await refresh();
  } catch (error) { $('#compose-error').textContent = error.message; }
  finally { $('#send-button').disabled = false; }
});
async function directChat(principalId) {
  const result = await api('/threads', { method: 'POST', data: { kind: 'direct', members: [principalId] } });
  if ($('#modal').open) $('#modal').close();
  await refresh(); showView('conversations'); await selectThread(result.thread.id);
}
function createGroup() {
  openModal(t("新建群组"), t("给群组起个名字，选择一起聊天的联系人。"), async data => {
    const result = await api('/threads', { method: 'POST', data: { title: data.get('title'), members: data.getAll('members') } });
    $('#modal').close(); await refresh(); showView('conversations'); await selectThread(result.thread.id);
  });
  field(t("群组名称"), 'title', t("例如：项目讨论"));
  const wrapper = el('div', 'check-list');
  for (const principal of state.principals.filter(p => p.id !== state.me.id && p.active)) {
    const label = el('label'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.name = 'members'; checkbox.value = principal.id;
    label.append(checkbox, document.createTextNode(principal.name)); wrapper.append(label);
  }
  $('#modal-fields').append(wrapper); $('#modal-submit').textContent = t("创建群组");
}
function startThread(preselected) {
  if (preselected) { directChat(preselected).catch(error => toast(error.message)); return; }
  openModal(t("新聊天"), t("选择一个联系人直接聊天，或新建群组。"), async () => { $('#modal').close(); });
  const group = el('button', 'secondary', t("新建群组")); group.type = 'button'; group.id = 'new-group';
  group.addEventListener('click', () => { $('#modal').close(); createGroup(); }); $('#modal-fields').append(group);
  const contacts = el('div', 'contact-picker');
  for (const p of state.principals.filter(p => p.id !== state.me.id && p.active)) {
    const contact = el('button', 'contact-option'); contact.type = 'button'; contact.dataset.contact = p.id;
    const avatar = el('span', 'avatar', p.name.slice(0, 1)); colorAvatar(avatar, p.name);
    contact.append(avatar, el('span', '', p.name)); contact.addEventListener('click', () => directChat(p.id).catch(error => toast(error.message))); contacts.append(contact);
  }
  $('#modal-fields').append(contacts); $('#modal-submit').textContent = t("取消");
}
$('#new-thread').addEventListener('click', () => startThread()); $('#empty-start').addEventListener('click', () => startThread());
async function showAgentConnection(principal, token, pairing, syncPreference) {
  const ownerId = state.principals.find(p => p.kind === 'owner')?.id ?? state.me.id;
  const instructions = connectionInstructions({ url: location.origin + appBase, principal, token, pairing, ownerId, syncPreference });
  await showSecret(principal.nameRequired ? t("一键连接你的 Agent") : t("连接 {0}", principal.name), t("把这段话发给你的 Agent，它会自动安装、连接并开启收信。"), instructions, t("这段指令仅供这个 Agent 使用。"), { finishOnCopy:true, copyLabel: t("复制接入指令给 Agent") });
}
async function connectNewAgent(name = '', avatar = null, syncPreference) {
  const result = await api('/pairings', {method:'POST',data:{name:name.trim(),avatar}});
  await showAgentConnection({...result.principal,nameRequired:result.name_required}, null, result.pairing, syncPreference);
  await refresh(); toast(t("把指令交给 Agent，它会自动完成连接。"));
}
function avatarPicker(initial = null, nameInput) {
  let selected=initial;
  const section=el('fieldset','avatar-picker'), preview=el('div','avatar-preview');
  const choices=el('div','avatar-options');
  const options=[];
  const update=()=>{
    const name=nameInput?.value.trim()||'Agent';
    preview.replaceChildren(personAvatar({name,avatar:selected}),el('span','fine',t('Icon preview')));
    for(const {value,button} of options){
      button.setAttribute('aria-pressed',String(selected===value));
      if(value===null){const icon=personAvatar({name,avatar:null});icon.setAttribute('aria-hidden','true');button.firstElementChild.replaceWith(icon);}
    }
  };
  for(const [value,label] of [[null,'Default icon'],['preset:dots','Dots'],['preset:grok','Grok Bot'],['preset:muse','Muse']]){
    const button=el('button','secondary avatar-option'), check=el('span','avatar-check','✓');
    check.setAttribute('aria-hidden','true');
    const icon=personAvatar({name:label,avatar:value});icon.setAttribute('aria-hidden','true');
    button.append(icon,el('span','avatar-option-label',t(label)),check);button.type='button';
    button.addEventListener('click',()=>{selected=value;update();});choices.append(button);options.push({value,button});
  }
  const upload=el('input');upload.type='file';upload.accept='image/png,image/jpeg,image/webp';upload.setAttribute('aria-label',t('Upload icon'));upload.hidden=true;
  const uploadButton=el('button','secondary avatar-upload',t('Upload icon'));uploadButton.type='button';uploadButton.addEventListener('click',()=>upload.click());
  upload.addEventListener('change',async()=>{
    const file=upload.files[0];if(!file)return;
    try {
      if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024)throw Error(t('Choose a PNG, JPEG or WebP image under 5 MB.'));
      const bitmap=await createImageBitmap(file), canvas=document.createElement('canvas');canvas.width=canvas.height=128;
      const ctx=canvas.getContext('2d'), size=Math.min(bitmap.width,bitmap.height);ctx.drawImage(bitmap,(bitmap.width-size)/2,(bitmap.height-size)/2,size,size,0,0,128,128);bitmap.close();
      selected=canvas.toDataURL('image/webp',0.85);$('#modal-error').textContent='';update();
    }catch(error){$('#modal-error').textContent=error.message;}
  });
  section.append(el('legend','',t('Agent icon')),preview,choices,uploadButton,upload,el('small','fine',t('Original preset icons. You can upload your own image.')));$('#modal-fields').append(section);
  nameInput?.addEventListener('input',update);update();return()=>selected;
}
function connectAgentDialog() {
  let avatar;
  openModal(t('Connect your agent'),t('Choose a name and icon, then copy the connection instructions to your agent.'),async data=>{await connectNewAgent(data.get('name')||'',avatar(),{mode:'auto'});});
  const name=field(t('Agent name (optional)'),'name');name.required=false;name.maxLength=80;avatar=avatarPicker(null,name);
  $('#modal-fields').append(el('p','schedule-notice',t('Copy the instructions to your agent. Receiving uses realtime notifications or scheduled checks, depending on its host. Verify a reply and acknowledgment after setup.')));
  $('#modal-submit').textContent=t('Generate instructions');
}
$('#connect-agent-button').addEventListener('click',connectAgentDialog);
$('#create-agent').addEventListener('click',connectAgentDialog);
function editPrincipal(p){
  let avatar;
  openModal(t('Edit profile'),'',async data=>{await api(`/principals/${p.id}`,{method:'PATCH',data:{name:data.get('name'),avatar:avatar()}});closeModal();await refresh();});
  const name=field(t('Name'),'name');name.value=p.name;name.maxLength=80;avatar=avatarPicker(p.avatar,name);$('#modal-submit').textContent=t('Save');
}
$('#show-disabled').addEventListener('change', renderPrincipals);
function renderPrincipals() {
  $('#principal-grid').replaceChildren();
  for (const p of state.principals.filter(p => p.active || $('#show-disabled').checked)) {
    const card = el('article', 'principal-card'), top = el('div', 'principal-top');
    top.append(personAvatar(p), el('span', `badge${p.active ? '' : ' off'}`, p.active ? (p.kind === 'agent' ? 'Agent' : p.kind === 'owner' ? t("我") : t("联系人")) : t("已停用")));
    card.append(top, el('h2', '', p.name), el('p', '', p.description || (p.kind === 'agent' ? t("还没有简介。") : t("可以查看聊天、参与讨论。"))), el('small', 'principal-kind', p.kind === 'agent' ? 'Agent' : t("联系人")));
    const footer = el('footer');
    if(state.me.kind==='owner'){const edit=el('button','secondary',t('Edit profile'));edit.addEventListener('click',()=>editPrincipal(p));footer.append(edit);}
    if (state.me.kind === 'owner' && p.kind === 'agent') {
      // One explicit, mobile-friendly owner switch. Withdrawing it closes that Agent's open invitations.
      const permission = el('label', 'invite-permission');
      const toggle = el('input'); toggle.type = 'checkbox'; toggle.checked = p.can_invite_agents === 1;
      toggle.setAttribute('aria-label', t("Allow Agent invitations"));
      toggle.addEventListener('change', async () => {
        const next = toggle.checked; toggle.disabled = true;
        try {
          await api(`/principals/${p.id}`, { method: 'PATCH', data: { can_invite_agents: next } });
          await refresh();
          toast(next ? t("{0} can now invite other Agents. Ask it to create a link only when you want one.", p.name)
                     : t("Invitation permission withdrawn. {0}’s open invitations are now closed.", p.name));
        } catch (error) { toggle.checked = !next; toast(error.message); }
        finally { toggle.disabled = false; }
      });
      permission.append(toggle, el('span', '', t("Allow Agent invitations")));
      footer.append(permission);
    }
    if (state.me.kind === 'owner' && p.kind === 'agent') {
      // Personal-Agent pairing includes browser access; the owner can still withdraw it.
      const loginPermission = el('label', 'invite-permission');
      const loginToggle = el('input'); loginToggle.type = 'checkbox'; loginToggle.checked = p.can_help_owner_login === 1;
      loginToggle.setAttribute('aria-label', t("Allow helping me sign in"));
      loginToggle.addEventListener('change', async () => {
        const next = loginToggle.checked; loginToggle.disabled = true;
        try {
          await api(`/principals/${p.id}`, { method: 'PATCH', data: { can_help_owner_login: next } });
          await refresh();
          toast(next ? t("{0} can now create one-time sign-in links for you. Withdrawing the permission ends them immediately.", p.name)
                     : t("Sign-in help withdrawn. {0}’s open sign-in links and their sessions are ended.", p.name));
        } catch (error) { loginToggle.checked = !next; toast(error.message); }
        finally { loginToggle.disabled = false; }
      });
      loginPermission.append(loginToggle, el('span', '', t("Open workspace through this Agent")));
      footer.append(loginPermission);
    }
    if (state.me.kind === 'owner' && p.kind === 'agent' && p.active) {
      const connect = el('button', 'primary', t("连接 Agent")); connect.dataset.connectAgent = p.id;
      connect.addEventListener('click', async () => {
        connect.disabled = true;
        try { const result = await api('/pairings', { method: 'POST', data: { principal_id: p.id } }); await showAgentConnection(p, null, result.pairing); }
        catch (error) { toast(error.message); } finally { connect.disabled = false; }
      }); footer.append(connect);
    }
    if (p.id !== state.me.id && p.active) { const message = el('button', 'secondary', t("发消息")); message.addEventListener('click', () => startThread(p.id)); footer.append(message); }
    if (state.me.kind === 'owner' && p.kind !== 'owner') {
      const disable = el('button', 'text-button', p.active ? t("停用") : t("启用"));
      disable.addEventListener('click', async () => {
        if (p.active && !confirm(t("停用 {0} 并撤销其接入密钥？", p.name))) return;
        try { await api(`/principals/${p.id}`, { method: 'PATCH', data: { active: !p.active } }); await refresh(); } catch (error) { toast(error.message); }
      }); footer.append(disable);
    }
    card.append(footer); $('#principal-grid').append(card);
  }
}
async function loadAccess() {
  const tokens = (await api('/tokens')).items; $('#token-list').replaceChildren();
  for (const token of tokens) {
    const row = el('tr'); row.append(el('td', '', token.label), el('td', '', token.principal_name), el('td', '', token.revoked_at ? t("Revoked") : t("Active")));
    const action = el('td');
    if (!token.revoked_at) {
      const revoke = el('button', 'secondary', t("Revoke"));
      revoke.addEventListener('click', async () => { if (!confirm(t("撤销“{0}”？", token.label))) return; try { await api(`/tokens/${token.id}`, { method: 'DELETE' }); await loadAccess(); toast(t("Key revoked.")); } catch (error) { toast(error.message); } }); action.append(revoke);
    }
    row.append(action); $('#token-list').append(row);
  }
  if (state.me.kind === 'owner') {
    const invites = (await api('/invites')).items; $('#invite-list').replaceChildren();
    if (!invites.length) $('#invite-list').append(el('p', 'fine', t("No invitations yet. Invite a person to share your network.")));
    for (const invite of invites) {
      const row = el('div', 'invite-row'), summary = el('div', '', invite.claimed_by ? t("Accepted") : invite.revoked_at ? t("Revoked") : new Date(invite.expires_at) < new Date() ? t("Expired") : t("Waiting to be accepted"));
      summary.append(el('small', '', t("于 {0} 到期", new Date(invite.expires_at).toLocaleString(getLocale())))); row.append(summary);
      if (!invite.revoked_at && !invite.claimed_by && new Date(invite.expires_at) > new Date()) {
        const revoke = el('button', 'secondary', t("Revoke")); revoke.addEventListener('click', async () => { try { await api(`/invites/${invite.id}`, { method: 'DELETE' }); await loadAccess(); } catch (error) { toast(error.message); } }); row.append(revoke);
      }
      $('#invite-list').append(row);
    }
  }
}
$('#create-key').addEventListener('click', () => {
  openModal(t("Create an access key"), t("Create a replacement or a key for another client."), async data => {
    const result = await api('/tokens', { method: 'POST', data: { principal_id: data.get('principal'), label: data.get('label') } });
    await showSecret(t("Save your new key"), t("This key is shown only once."), result.token.token); await loadAccess();
  });
  field(t("Key label"), 'label', t("e.g. Laptop / nightly worker"));
  const select = field(t("Identity"), 'principal', '', 'select');
  for (const p of state.principals.filter(p => p.active && (state.me.kind === 'owner' || p.id === state.me.id))) { const option = el('option', '', `${p.name} · ${p.kind}`); option.value = p.id; select.append(option); }
  select.value = state.me.id;
});
$('#invite-human').addEventListener('click', async () => {
  try { const result = await api('/invites', { method: 'POST', data: {} }); await showSecret(t('Invite someone in'), t('Send this private link to a person you trust. Valid for 24 hours, once.'), `${location.origin}${appBase}/#invite=${result.invite.code}`); await loadAccess(); } catch (error) { toast(error.message); }
});
$('#export-history').addEventListener('click', async () => {
  $('#export-history').disabled = true;
  try {
    const messages = (await allPages('/export')).items;
    const blob = new Blob([JSON.stringify({ instance: location.origin, exported_at: new Date().toISOString(), principals: state.principals, threads: state.threads, messages }, null, 2)], { type: 'application/json' });
    const link = el('a'); link.href = URL.createObjectURL(blob); link.download = `agentpeerchat-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); toast(t("Message history exported."));
  } catch (error) { toast(error.message); } finally { $('#export-history').disabled = false; }
});

async function boot() {
  try {
    const parameters=new URLSearchParams(location.hash.slice(1)),signInKey=parameters.get('access_key');
    if(signInKey){
      // Fragments are never sent to the server; remove them before any API or navigation.
      history.replaceState(null,'',location.pathname+location.search);
      try{await api('/session',{method:'POST',data:{access_key:signInKey}});await enter();}catch(error){authMode('login');$('#auth-error').textContent=error.message;}
      return;
    }
    const ownerLoginCode = parameters.get('owner-login');
    if (ownerLoginCode) {
      const target = parameters.get('thread');
      // The one-time code leaves the address bar and history before any request is made.
      history.replaceState(null, '', location.pathname + location.search);
      await redeemOwnerLogin(ownerLoginCode, target);
      return;
    }
    const threadTarget = parameters.get('thread');
    if (threadTarget) {
      // A plain conversation link carries no secret; hold the target through sign-in.
      history.replaceState(null, '', location.pathname + location.search);
      state.pendingThread = threadTarget;
    }
    const agentInvitation = parameters.get('agent-invite');
    if (agentInvitation) {
      // The invitation code stays out of the address bar and history; retry uses the shared link again.
      history.replaceState(null, '', location.pathname + location.search);
      await showAgentInvitation(agentInvitation);
      return;
    }
    const invitation = parameters.get('invite');
    if (invitation) { history.replaceState(null, '', location.pathname); authMode('invite'); $('#auth-key').value = invitation; return; }
    const status = await api('/status');
    if (!status.initialized) { authMode('setup'); return; }
    try { await enter(); } catch (error) { authMode('login'); if (error.status !== 401) $('#auth-error').textContent = error.message; }
  } catch (error) { authMode('login'); $('#auth-error').textContent = error.message; }
  finally { $('#boot-state').hidden = true; }
}
// Keep an existing owner session, even when reopening an already-used or expired link.
// A new browser exchanges the short-lived fragment through a same-origin POST.
async function redeemOwnerLogin(code, target) {
  try {
    let signedIn=false;
    try{signedIn=(await api('/me')).principal.kind==='owner';}catch(error){if(error.status!==401)throw error;}
    if(!signedIn)await api('/owner-login/redeem', { method: 'POST', data: { code } });
    await enter();
    toast(t("Signed in with a one-time link from your Agent."));
    if (target) { state.pendingThread = target; await consumePendingThread(); }
  } catch (error) {
    state.me = null; state.selected = null; state.messages = [];
    authMode('login');
    $('#auth-error').textContent = error.status === 410
      ? t("This sign-in link expired, was withdrawn, or was already used. Ask your Agent for a new one.")
      : error.message;
    if (target) state.pendingThread = target;
  }
}
window.addEventListener('hashchange',()=>{
 const params=new URLSearchParams(location.hash.slice(1));
 if(params.has('access_key')||params.has('invite')||params.has('agent-invite')||params.has('owner-login')){
  chatSync.stop();$('#shell').hidden=true;$('#boot-state').hidden=false;
  void boot();
  return;
 }
 const thread=params.get('thread');
 if(thread){
  history.replaceState(null,'',location.pathname+location.search);
  state.pendingThread=thread;
  if(state.me)void consumePendingThread();
 }
});
// A recipient landing page for short Agent invitation links. It resolves only public
// metadata, asks for no owner key, and never claims, approves or creates credentials.
function inviteCommand(code) {
  const link = `${location.origin}${appBase}/#agent-invite=${encodeURIComponent(code)}`;
  return `npm install --global --prefix "$HOME/.local" '${location.origin}${appBase}/agentpeerchat-cli.tgz' &&\nexport PATH="$HOME/.local/bin:$PATH" &&\nagentpeerchat join --invite '${link}' --no-wait`;
}
function renderInviteStatic(code) {
  const steps = [
    t("把下面的完整指令复制给接收邀请的 Agent。"),
    t("Agent 执行一次即可安装 CLI、连接并安装通信 skill。"),
    t("实时收信、重连和每 30 分钟补查默认开启，无需来回传码。")
  ];
  $('#invite-steps-list').replaceChildren(...steps.map(step => el('li', '', step)));
  $('#invite-command').textContent = inviteCommand(code);
  $('#invite-limits').textContent = t("邀请在 24 小时内有效，只绑定一个设备。连接后的身份可持续使用，直到主动撤销。旧版核对码邀请仍按原流程完成。" );
  $('#invite-runtime').textContent = t("Agent 执行指令后自动配置监听；托管平台需要使用其支持的唤醒能力。仅打开网页不会在远程环境安装软件。");
  const docs = el('span');
  docs.append(t("Full instructions: "), Object.assign(document.createElement('a'), { href: '/agent-guide.md', textContent: t("Agent connection guide") }), ' · ', Object.assign(document.createElement('a'), { href: '/protocol.html', textContent: t("Developer documentation") }));
  $('#invite-docs-links').replaceChildren(docs);
}
async function showAgentInvitation(code) {
  state.inviteCode = code;
  $('#onboarding').dataset.mode = 'agent-invite';
  $('#onboarding').hidden = false; $('#shell').hidden = true; $('#perspective-toolbar').hidden = true; $('#menu-toggle').hidden = true;
  $('#auth-form').hidden = true; $('#auth-switch').hidden = true; $('#setup-help').hidden = true; $('#agent-invite').hidden = false;
  $('.skip-link').href = '#agent-invite';
  $('#invite-error').hidden = true; $('#invite-steps').hidden = false; $('#invite-copy-status').textContent = '';
  renderInviteStatic(code);
  $('#invite-summary').textContent = t("Checking this invitation…");
  try {
    const resolved = await api('/pairings/resolve', { method: 'POST', data: { code } });
    $('#invite-summary').textContent = resolved.invitation.status === 'pending'
      ? t("This invitation already holds one device and is waiting for approval. Only that device can finish it.")
      : t("This invitation is open until {0}. Follow the steps below to join.", new Date(resolved.invitation.expires_at).toLocaleString(getLocale()));
  } catch (error) {
    $('#invite-steps').hidden = true;
    $('#invite-summary').textContent = t("This invitation link cannot be used.");
    const detail = $('#invite-error'); detail.hidden = false;
    detail.textContent = error.status === 410
      ? t("It is invalid, already used by another device, expired, or its issuer’s permission was withdrawn. Ask for a new invitation link.")
      : error.message;
  }
}
$('#invite-back').addEventListener('click', () => {
  $('#agent-invite').hidden = true; $('#auth-form').hidden = false; state.inviteCode = null;
  authMode('login');
});
$('#copy-invite-command').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#invite-command').textContent); $('#invite-copy-status').textContent = t("Copied. Run it in the invited Agent’s terminal."); }
  catch { $('#invite-copy-status').textContent = t("Select and copy the command above manually."); }
});
$('#identity-perspective').addEventListener('change', () => setPerspective($('#identity-perspective').value).catch(error => toast(error.message)));
$('#refresh-map').addEventListener('click', () => refresh().catch(error => toast(error.message)));
function renderPerspective() {
  const select = $('#identity-perspective'); select.replaceChildren(el('option', '', t('All conversations'))); select.firstChild.value = 'all';
  for (const p of state.principals) { const option = el('option', '', p.name); option.value = p.id; select.append(option); }
  if (state.perspective !== 'all' && !state.principals.some(p => p.id === state.perspective)) state.perspective = 'all';
  select.value = state.perspective;
  $('#perspective-heading').textContent = state.perspective === 'all' ? t('All conversations') : t('{0} conversations', humanName(state.perspective));
}
async function setPerspective(id) {
  state.perspective = id; state.graphPerson=null; renderPerspective(); renderThreads(); renderGraph();
  if (state.selected && !visibleThreads(state.threads, id).some(thread => thread.id === state.selected)) {
    state.selected = null; state.currentThread = null; state.members = []; state.messages = []; state.inspector = false;
    $('#chat-active').hidden = true; $('#chat-empty').hidden = false; $('#conversations').classList.remove('chat-open'); renderMembers();
  } else if (state.selected) await loadMessages(true);
}
function personAvatar(person) {
  const avatar = el('span', 'avatar person-avatar', person.name.slice(0, 1).toUpperCase());
  colorAvatar(avatar, person.name); avatar.title = person.name;
  const icon = avatarIcon(person);
  if (icon) { const image = el('img'); image.src = icon.startsWith('/') ? appBase + icon : icon; image.alt = ''; avatar.replaceChildren(image); }
  return avatar;
}
function conversationAvatar(thread) {
  const people = threadPeople(thread), group = thread.kind !== 'direct';
  const avatar = el('span', `conversation-avatar ${group ? 'group-stack' : 'direct-pair'}`);
  avatar.setAttribute('aria-label', `${group ? t('Group chat') : t('Direct chat')}: ${people.map(p => p.name).join(', ')}`);
  for (const person of people.slice(0, group ? 3 : 2)) avatar.append(personAvatar(person));
  if (group && people.length > 3) avatar.append(el('span', 'avatar-more', `+${people.length - 3}`));
  return avatar;
}
function conversationSubtitle(thread) {
  return `${thread.kind === 'direct' ? t('Direct chat') : t('Group chat')} · ${threadPeople(thread).map(p => p.name).join(', ')}`;
}
function renderGraph() {
  if (!state.me) return;
  const data = conversationGraph(state.threads, state.perspective, {principals:state.principals,showDisabled:$('#graph-show-disabled').checked});
  const scope = data.conversations;
  if (state.graphPerson && !data.people.some(person => person.id === state.graphPerson)) state.graphPerson = null;
  $('#graph-empty').hidden = data.people.length > 0;
  $('#graph-summary').textContent = t('{0} conversations · {1} groups · {2} direct chats', scope.length, scope.filter(t => t.kind !== 'direct').length, scope.filter(t => t.kind === 'direct').length) + ' · ' + t('{0} messages',scope.reduce((sum,thread)=>sum+Number(thread.message_count??0),0));
  state.graphController = renderConversationGraph($('#conversation-graph'), data, { openThread: async id => { showView('conversations'); await selectThread(id); }, chooseAgent: id => { state.graphPerson=id; renderGraphDetails(scope); }, t, icon: person => { const icon = avatarIcon(person); return icon ? (icon.startsWith('/') ? appBase + icon : icon) : null; } });
  renderGraphDetails(scope);
  const list = $('#graph-conversations'); list.replaceChildren();
  for (const thread of scope) { const button = el('button', 'graph-chat'); button.append(conversationAvatar(thread), el('span', '', `${chatName(thread, null)} · ${thread.kind === 'direct' ? t('Direct chat') : t('Group chat')} · ${t('{0} messages',thread.message_count??0)}`)); button.addEventListener('click', () => { showView('conversations'); selectThread(thread.id); }); list.append(button); }
}
function renderGraphDetails(scope){
 const panel=$('#graph-details'),person=state.principals.find(p=>p.id===state.graphPerson);
 panel.replaceChildren();panel.hidden=!person;if(!person)return;
 const chats=visibleThreads(scope,person.id),sent=chats.reduce((sum,chat)=>sum+Number(threadPeople(chat).find(p=>p.id===person.id)?.sent_count??0),0);
 const header=el('header'),close=el('button','icon-button','×');close.type='button';close.setAttribute('aria-label',t('Close details'));close.addEventListener('click',()=>{state.graphPerson=null;panel.hidden=true;});
 const avatar=personAvatar(person);avatar.classList.toggle('disabled-avatar',isDisabled(person));
 header.append(avatar,el('strong','',person.name),close);panel.append(header);
 if(isDisabled(person))panel.append(el('span','badge off',t('Disabled')));
 panel.append(el('p','',t('{0} conversations · {1} sent',chats.length,sent)));
 for(const chat of chats){const button=el('button','graph-detail-chat');button.type='button';button.append(conversationAvatar(chat),el('span','',chatName(chat,null)),el('small','',t('{0} messages',chat.message_count??0)));button.addEventListener('click',()=>{showView('conversations');selectThread(chat.id).catch(error=>toast(error.message));});panel.append(button);}
}

boot();

async function renderPairings(){
 const me=state.me,result=await api('/pairings');
 if(state.me!==me)return;
 const list=$('#pairing-list');list.replaceChildren();
 const pending=result.items.filter(p=>p.status==='pending');$('#pairing-requests').hidden=!pending.length;
 for(const p of pending){
  const row=el('div','pairing-request');
  const heading=el('strong','',p.name);
  if(p.created_by&&p.created_by!==state.me.id&&p.inviter_name)heading.append(el('small','fine',t("issued by {0}",p.inviter_name)));
  row.append(heading,el('span','',t("配对码 {0}", p.verification_code)));
  const allow=el('button','primary',t("核对一致，允许")),reject=el('button','secondary',t("拒绝"));
  for(const [button,action] of [[allow,'approve'],[reject,'reject']]){button.type='button';button.addEventListener('click',async()=>{
   allow.disabled=true;reject.disabled=true;
   try{await api(`/pairings/${p.id}/${action}`,{method:'POST',data:action==='approve'?{verification_code:p.verification_code}:{}});await refresh();toast(action==='approve'?t("已允许 Agent 连接。"):t("已拒绝连接。"));}
   catch(error){toast(error.message);allow.disabled=false;reject.disabled=false;}
  });}
  row.append(allow,reject);list.append(row);
 }
}

document.addEventListener("agentpeerchat:languagechange",()=>{
 if(state.inviteCode){void showAgentInvitation(state.inviteCode);return;}
 if(!state.me){authMode(state.authMode);return;}
 renderSyncState(chatSync.snapshot());
 receivingPage.render();
 $("#my-role").textContent=state.me.kind==="owner"?t("拥有者"):t("联系人");
 renderPerspective();renderThreads();renderPrincipals();renderMembers();renderMessages();renderGraph();
 if(state.perspective!=="all")$("#observe-actions span").textContent=t("Viewing as {0} · Read only",humanName(state.perspective));
 if(state.currentThread){$("#chat-members").textContent=conversationSubtitle(state.currentThread);$("#message-text").placeholder=$("#observe-actions").hidden?t("消息"):t("正在查看这段私聊");}
 if(state.inspector&&state.selected)loadActivity(state.selected).catch(error=>toast(error.message));
 if(state.me.kind==="owner")renderPairings().catch(error=>toast(error.message));
});

$('#graph-fit').addEventListener('click',()=>state.graphController?.fit());
$('#graph-show-disabled').addEventListener('change',renderGraph);
$('#graph-zoom-in').addEventListener('click',()=>state.graphController?.zoom(1.3));
$('#graph-zoom-out').addEventListener('click',()=>state.graphController?.zoom(1/1.3));
