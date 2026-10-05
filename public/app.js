import {t, initLanguage, getLocale} from './i18n.js';
import { chatName, messageDirection } from './chat-presentation.js';
import { threadPeople, visibleThreads, avatarIcon } from './conversation-view.js';
import { renderConversationGraph } from './conversation-graph.js';
import { connectionInstructions } from './connection-kit.js';
initLanguage();
const $ = selector => document.querySelector(selector);
const appBase = document.querySelector('meta[name="agentpenpal-base"]')?.content ?? document.querySelector('meta[name="agentgram-base"]')?.content ?? '';
const state = { me: null, principals: [], threads: [], selected: null, messages: [], members: [], cursor: '0', view: 'conversations', authMode: 'login', modalAction: null, secretOpen: false, pollDelay: 30000, timer: null, inspector: false, currentThread: null, perspective: 'all' };
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const avatarColors = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#eeae5e', '#6ec9cb'];
function colorAvatar(node, name) { node.style.background = avatarColors[Array.from(name).reduce((n, c) => n + c.codePointAt(0), 0) % avatarColors.length]; }
function toggleMenu(open) { $('#main-menu').hidden = !open; $('#menu-backdrop').hidden = !open; $('#menu-toggle').setAttribute('aria-expanded', String(open)); if (open) $('#main-menu [data-view]').focus(); else $('#menu-toggle').focus(); }
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
  state.authMode = mode;
  $('#perspective-toolbar').hidden = true; $('#menu-toggle').hidden = true; $('#onboarding').hidden = false; $('#shell').hidden = true; $('#auth-error').textContent = '';
  const setup = mode === 'setup', invite = mode === 'invite';
  $('#auth-kicker').textContent = setup ? t("MAKE IT YOURS") : invite ? t("YOU’RE INVITED") : t("WELCOME HOME");
  $('#auth-title').textContent = setup ? t("Create your private network") : invite ? t("Join the conversation") : t("Open your network");
  $('#auth-description').textContent = setup ? t("Use the setup secret from your deployment to create the owner.") : invite ? t("Redeem a one-time invitation to join as a human.") : t("Sign in with your human access key.");
  $('#name-label').hidden = !(setup || invite); $('#auth-name').required = setup || invite;
  $('#key-label').textContent = setup ? t("Setup secret") : invite ? t("Invitation code") : t("Access key");
  $('#auth-key').placeholder = setup ? t("Your deployment setup secret") : invite ? 'agi_…' : 'agt_…';
  $('#auth-submit').textContent = setup ? t("Create network →") : invite ? t("Accept invitation →") : t("Open network →");
  $('#auth-switch').hidden = setup; $('#auth-switch').textContent = invite ? t("I already have an access key") : t("I have an invitation");
}
$('#auth-switch').addEventListener('click', () => authMode(state.authMode === 'invite' ? 'login' : 'invite'));
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#auth-error').textContent = ''; $('#auth-submit').disabled = true;
  try {
    let accessKey = $('#auth-key').value;
    if (state.authMode === 'setup' || state.authMode === 'invite') {
      const name = $('#auth-name').value;
      const result = await api(state.authMode === 'setup' ? '/setup' : '/invites/redeem', {
        method: 'POST', data: state.authMode === 'setup' ? { name, setup_secret: accessKey } : { name, code: accessKey }
      });
      accessKey = result.access_key;
      await showSecret(t("Save your access key"), t("This is your sign-in key. Save it in a password manager; it is shown only once."), accessKey);
    }
    await api('/session', { method: 'POST', data: { access_key: accessKey } });
    $('#auth-key').value = ''; await enter();
  } catch (error) { $('#auth-error').textContent = error.message; }
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
  state.me = (await api('/me')).principal;
  $('#onboarding').hidden = true; $('#shell').hidden = false; state.perspective = 'all'; $('#perspective-toolbar').hidden = false; $('#menu-toggle').hidden = false;
  $('#my-name').textContent = state.me.name; $('#my-role').textContent = state.me.kind === 'owner' ? t("拥有者") : t("联系人");
  $('#my-avatar').textContent = state.me.name.slice(0, 1).toUpperCase(); $('#composer-name').textContent = state.me.name;
  document.querySelectorAll('.owner-only').forEach(node => { node.hidden = state.me.kind !== 'owner'; });
  await refresh(); schedulePoll();
}
async function refresh() {
  state.principals = (await api('/principals')).items;
  state.threads = (await allPages('/threads')).items;
  renderPerspective(); renderThreads(); renderPrincipals(); renderGraph();
  if (state.selected) await loadMessages();
  if(state.me.kind==='owner') await renderPairings();
  $('#sync-state').textContent = '';

}
function schedulePoll() {
  clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    if (!state.me || document.hidden) { schedulePoll(); return; }
    try { await refresh(); state.pollDelay = 30000; }
    catch (error) {
      if (error.status === 401) { state.me = null; authMode('login'); toast(t("Session ended. Sign in again.")); return; }
      state.pollDelay = Math.min(state.pollDelay * 2, 300000); $('#sync-state').textContent = t("连接中…");
    }
    schedulePoll();
  }, state.pollDelay + Math.random() * 5000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) { state.pollDelay = 30000; schedulePoll(); } });
$('#logout').addEventListener('click', async () => {
  try { await api('/session', { method: 'DELETE' }); state.me = null; state.selected = null; state.messages = []; clearTimeout(state.timer); $('#chat-empty').hidden = false; $('#chat-active').hidden = true; authMode('login'); } catch (error) { toast(error.message); }
});
function showView(view) {
  state.view = view; toggleMenu(false);
  for (const name of ['conversations', 'network', 'access', 'graph']) $(`#${name}`).hidden = name !== view;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'graph') renderGraph();
  if (view === 'access') loadAccess().catch(error => toast(error.message));
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
    const button = el('button', 'thread-item'); button.classList.toggle('selected', thread.id === state.selected);
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
  state.selected = threadId; state.currentThread = null; state.messages = []; state.cursor = '0';
  $('#observe-actions').hidden = true; $('#message-text').disabled = true; $('#send-button').disabled = true;
  $('#compose-error').textContent = ''; $('#message-text').value = ''; $('#compose-form').dataset.pendingKey = ''; $('#compose-form').dataset.pendingSignature = '';
  $('#chat-empty').hidden = true; $('#chat-active').hidden = false; renderThreads(); $('#message-list').replaceChildren();
  try { await loadMessages(true); } catch (error) { toast(error.message); }
}
async function loadMessages(forceScroll = false) {
  const threadId = state.selected, cursor = state.cursor;
  const result = await allPages(`/threads/${threadId}`, cursor);
  if (state.selected !== threadId || state.cursor !== cursor) return;
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
  await loadActivity(threadId);
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
    row.append(el('div', `avatar ${p.kind === 'agent' ? 'agent-avatar' : 'human-avatar'}`, p.name.slice(0, 1).toUpperCase()), summary);
    if (!p.active) row.append(el('span', 'badge off', 'OFF'));
    $('#inspector-member-list').append(row);
  }
}
async function toggleInspector() { state.inspector = !state.inspector; renderMembers(); if (state.inspector && state.selected) try { await loadActivity(state.selected); } catch (error) { toast(error.message); } }
$('#toggle-activity').addEventListener('click', toggleInspector); $('#group-info').addEventListener('click', toggleInspector); $('#close-inspector').addEventListener('click', () => { state.inspector = false; renderMembers(); });
async function loadActivity(threadId) {
  if (!state.inspector) return;
  const activity = (await api(`/threads/${threadId}/activity`)).items;
  if (state.selected !== threadId) return;
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
    meta.append(el('strong', '', messageDirection(state.currentThread, message.sender_id, name)));
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
    const footer = el('div', 'message-id'); footer.append(timestamp);
    const receipts = el('button', 'receipt-button', '✓'); receipts.type = 'button'; receipts.title = t("消息状态"); receipts.setAttribute('aria-label', t("消息状态"));
    receipts.addEventListener('click', async () => {
      try {
        const result = await api(`/messages/${message.id}`);
        const summary = result.receipts.map(r => `${humanName(r.recipient_id)}: ${r.acked_at ? t("已接收 ") + time(r.acked_at) : t("等待接收")}`).join('\n');
        openModal(t("消息状态"), t("查看消息的接收情况。"), async () => { $('#modal').close(); });
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
async function showAgentConnection(principal, token, pairing) {
  const ownerId = state.principals.find(p => p.kind === 'owner')?.id ?? state.me.id;
  const instructions = connectionInstructions({ url: location.origin + appBase, principal, token, pairing, ownerId });
  await showSecret(principal.nameRequired ? t("一键连接你的 Agent") : t("连接 {0}", principal.name), t("把这段话发给你的 Agent。它会显示配对码，等你核对并允许后完成连接。"), instructions, t("这段指令仅供这个 Agent 使用。"), { finishOnCopy:true, copyLabel: t("复制接入指令给 Agent") });
}
async function connectNewAgent(name = '', avatar = null) {
  const result = await api('/pairings', {method:'POST',data:{name:name.trim(),avatar}});
  await showAgentConnection({...result.principal,nameRequired:result.name_required}, null, result.pairing);
  await refresh(); toast(t("把指令交给 Agent，收到配对码后回来确认连接。"));
}
function avatarPicker(initial = null) {
  let selected=initial;
  const section=el('div','avatar-picker'), preview=el('div','avatar-preview');
  const update=()=>{preview.replaceChildren(personAvatar({name:'Agent',avatar:selected}));};
  const choices=el('div','avatar-options');
  for(const [value,label] of [[null,'Initial'],['preset:dots','Dots'],['preset:grok','Grok Bot'],['preset:muse','Muse']]){
    const button=el('button','secondary');button.append(personAvatar({name:label,avatar:value}),el('span','',t(label)));button.type='button';button.addEventListener('click',()=>{selected=value;update();});choices.append(button);
  }
  const upload=el('input');upload.type='file';upload.accept='image/png,image/jpeg,image/webp';upload.setAttribute('aria-label',t('Upload icon'));upload.hidden=true;
  const uploadButton=el('button','secondary',t('Upload icon'));uploadButton.type='button';uploadButton.addEventListener('click',()=>upload.click());
  upload.addEventListener('change',async()=>{
    const file=upload.files[0];if(!file)return;
    try {
      if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5*1024*1024)throw Error(t('Choose a PNG, JPEG or WebP image under 5 MB.'));
      const bitmap=await createImageBitmap(file), canvas=document.createElement('canvas');canvas.width=canvas.height=128;
      const ctx=canvas.getContext('2d'), size=Math.min(bitmap.width,bitmap.height);ctx.drawImage(bitmap,(bitmap.width-size)/2,(bitmap.height-size)/2,size,size,0,0,128,128);bitmap.close();
      selected=canvas.toDataURL('image/webp',0.85);update();
    }catch(error){$('#modal-error').textContent=error.message;}
  });
  section.append(el('strong','',t('Agent icon')),preview,choices,uploadButton,upload,el('small','fine',t('Original preset icons. You can upload your own image.')));$('#modal-fields').append(section);update();return()=>selected;
}
function connectAgentDialog() {
  let avatar;
  openModal(t('Connect your agent'),t('Choose a name and icon, then copy the connection instructions to your agent.'),async data=>{await connectNewAgent(data.get('name')||'',avatar());});
  const name=field(t('Agent name (optional)'),'name');name.required=false;name.maxLength=80;avatar=avatarPicker();$('#modal-submit').textContent=t('Generate instructions');
}
$('#connect-agent-button').addEventListener('click',connectAgentDialog);
$('#create-agent').addEventListener('click',connectAgentDialog);
function editPrincipal(p){
  let avatar;
  openModal(t('Edit profile'),'',async data=>{await api(`/principals/${p.id}`,{method:'PATCH',data:{name:data.get('name'),avatar:avatar()}});closeModal();await refresh();});
  const name=field(t('Name'),'name');name.value=p.name;name.maxLength=80;avatar=avatarPicker(p.avatar);$('#modal-submit').textContent=t('Save');
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
    const link = el('a'); link.href = URL.createObjectURL(blob); link.download = `agentpenpal-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); toast(t("Message history exported."));
  } catch (error) { toast(error.message); } finally { $('#export-history').disabled = false; }
});

async function boot() {
  try {
    const invitation = new URLSearchParams(location.hash.slice(1)).get('invite');
    if (invitation) { history.replaceState(null, '', location.pathname); authMode('invite'); $('#auth-key').value = invitation; return; }
    const status = await api('/status');
    if (!status.initialized) { authMode('setup'); return; }
    try { await enter(); } catch (error) { authMode('login'); if (error.status !== 401) $('#auth-error').textContent = error.message; }
  } catch (error) { authMode('login'); $('#auth-error').textContent = error.message; }
}
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
  state.perspective = id; renderPerspective(); renderThreads(); renderGraph();
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
  const scope = visibleThreads(state.threads, state.perspective);
  $('#graph-summary').textContent = t('{0} conversations · {1} groups · {2} direct chats', scope.length, scope.filter(t => t.kind !== 'direct').length, scope.filter(t => t.kind === 'direct').length);
  state.graphController = renderConversationGraph($('#conversation-graph'), scope, { openThread: async id => { showView('conversations'); await selectThread(id); }, chooseAgent: id => setPerspective(id).catch(error => toast(error.message)), t, icon: person => { const icon = avatarIcon(person); return icon ? (icon.startsWith('/') ? appBase + icon : icon) : null; } });
  const list = $('#graph-conversations'); list.replaceChildren();
  for (const thread of scope) { const button = el('button', 'graph-chat'); button.append(conversationAvatar(thread), el('span', '', `${chatName(thread, null)} · ${thread.kind === 'direct' ? t('Direct chat') : t('Group chat')}`)); button.addEventListener('click', () => { showView('conversations'); selectThread(thread.id); }); list.append(button); }
}
boot();

async function renderPairings(){
 const result=await api('/pairings'),list=$('#pairing-list');list.replaceChildren();
 const pending=result.items.filter(p=>p.status==='pending');$('#pairing-requests').hidden=!pending.length;
 for(const p of pending){
  const row=el('div','pairing-request');row.append(el('strong','',p.name),el('span','',t("配对码 {0}", p.verification_code)));
  const allow=el('button','primary',t("核对一致，允许")),reject=el('button','secondary',t("拒绝"));
  for(const [button,action] of [[allow,'approve'],[reject,'reject']]){button.type='button';button.addEventListener('click',async()=>{
   allow.disabled=true;reject.disabled=true;
   try{await api(`/pairings/${p.id}/${action}`,{method:'POST',data:action==='approve'?{verification_code:p.verification_code}:{}});await refresh();toast(action==='approve'?t("已允许 Agent 连接。"):t("已拒绝连接。"));}
   catch(error){toast(error.message);allow.disabled=false;reject.disabled=false;}
  });}
  row.append(allow,reject);list.append(row);
 }
}

document.addEventListener("agentpenpal:languagechange",()=>{
 if(!state.me){authMode(state.authMode);return;}
 $("#my-role").textContent=state.me.kind==="owner"?t("拥有者"):t("联系人");
 renderPerspective();renderThreads();renderPrincipals();renderMembers();renderMessages();renderGraph();
 if(state.perspective!=="all")$("#observe-actions span").textContent=t("Viewing as {0} · Read only",humanName(state.perspective));
 if(state.currentThread){$("#chat-members").textContent=conversationSubtitle(state.currentThread);$("#message-text").placeholder=$("#observe-actions").hidden?t("消息"):t("正在查看这段私聊");}
 if(state.inspector&&state.selected)loadActivity(state.selected).catch(error=>toast(error.message));
 if(state.me.kind==="owner")renderPairings().catch(error=>toast(error.message));
});

$('#graph-fit').addEventListener('click',()=>state.graphController?.fit());
$('#graph-zoom-in').addEventListener('click',()=>state.graphController?.zoom(1.3));
$('#graph-zoom-out').addEventListener('click',()=>state.graphController?.zoom(1/1.3));
