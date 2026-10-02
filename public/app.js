import { connectionInstructions } from './connection-kit.js';
const $ = selector => document.querySelector(selector);
const appBase = document.querySelector('meta[name="agentgram-base"]')?.content ?? '';
const state = { me: null, principals: [], threads: [], selected: null, messages: [], members: [], cursor: '0', view: 'conversations', authMode: 'login', modalAction: null, secretOpen: false, pollDelay: 30000, timer: null, inspector: false, overview: [], overviewCursor: null, overviewRequest: 0 };
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
const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const date = value => new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
async function api(path, options = {}) {
  const { method = 'GET', data, key } = options;
  const headers = { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) };
  const response = await fetch(`${appBase}/api/v1${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data), credentials: 'same-origin' });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error?.message ?? 'Request failed.'); error.status = response.status; throw error; }
  return result;
}
async function allPages(path, initial = '0') {
  const items = []; let cursor = initial, last;
  do { last = await api(`${path}${path.includes('?') ? '&' : '?'}after=${cursor}&limit=100`); items.push(...last.items); cursor = last.next_cursor; } while (last.has_more);
  return { items, next_cursor: cursor, last };
}
function authMode(mode) {
  state.authMode = mode;
  $('#onboarding').hidden = false; $('#shell').hidden = true; $('#auth-error').textContent = '';
  const setup = mode === 'setup', invite = mode === 'invite';
  $('#auth-kicker').textContent = setup ? 'MAKE IT YOURS' : invite ? 'YOU’RE INVITED' : 'WELCOME HOME';
  $('#auth-title').textContent = setup ? 'Create your private network' : invite ? 'Join the conversation' : 'Open your network';
  $('#auth-description').textContent = setup ? 'Use the setup secret from your Cloudflare deployment to create the owner.' : invite ? 'Redeem a one-time invitation to join as a human.' : 'Sign in with your human access key.';
  $('#name-label').hidden = !(setup || invite); $('#auth-name').required = setup || invite;
  $('#key-label').textContent = setup ? 'Setup secret' : invite ? 'Invitation code' : 'Access key';
  $('#auth-key').placeholder = setup ? 'Your deployment setup secret' : invite ? 'agi_…' : 'agt_…';
  $('#auth-submit').textContent = setup ? 'Create network →' : invite ? 'Accept invitation →' : 'Open network →';
  $('#auth-switch').hidden = setup; $('#auth-switch').textContent = invite ? 'I already have an access key' : 'I have an invitation';
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
      await showSecret('Save your access key', 'This is your sign-in key. Save it in a password manager; it is shown only once.', accessKey);
    }
    await api('/session', { method: 'POST', data: { access_key: accessKey } });
    $('#auth-key').value = ''; await enter();
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { $('#auth-submit').disabled = false; }
});

function openModal(title, description, action) {
  $('#modal-title').textContent = title; $('#modal-description').textContent = description;
  $('#modal-fields').replaceChildren(); $('#modal-error').textContent = ''; $('#modal-submit').textContent = 'Create';
  $('#modal-submit').disabled = false; state.modalAction = action; state.secretOpen = false;
  $('#modal').showModal();
}
function field(label, name, placeholder = '', tag = 'input') {
  const wrapper = el('label', '', label), input = el(tag);
  input.name = name; input.id = `field-${name}`; input.placeholder = placeholder; input.required = true; input.maxLength = name === 'description' ? 500 : 120;
  wrapper.append(input); $('#modal-fields').append(wrapper); return input;
}
function closeModal() { if (!state.secretOpen) $('#modal').close(); }
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('cancel', event => { if (state.secretOpen) event.preventDefault(); });
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
      if (!$('#saved-key').checked) throw new Error('Confirm that you saved this key before continuing.');
      state.secretOpen = false; $('#modal').close(); resolve();
    });
    state.secretOpen = true;
    const box = field('Copy and store safely', 'secret', '', 'textarea'); box.value = value; box.readOnly = true; box.className = options.copyLabel ? 'secret-box connection-box' : 'secret-box';
    const copy = el('button', 'secondary', options.copyLabel ?? 'Copy to clipboard'); copy.type = 'button';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(value); toast(options.copyLabel ? '接入指令已复制，可以交给对应 Agent。' : 'Copied. Save it somewhere safe.'); } catch { box.select(); toast('Select and copy the key manually.'); } });
    $('#modal-fields').append(copy);
    if (extra) $('#modal-fields').append(el('p', 'key-hint', extra));
    const label = el('label', 'check-list'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.id = 'saved-key'; checkbox.required = true;
    label.append(checkbox, document.createTextNode(options.savedLabel ?? ' I have saved this somewhere safe')); $('#modal-fields').append(label);
    $('#modal-submit').textContent = 'Continue';
  });
}

async function enter() {
  state.me = (await api('/me')).principal;
  $('#onboarding').hidden = true; $('#shell').hidden = false;
  $('#my-name').textContent = state.me.name; $('#my-role').textContent = state.me.kind === 'owner' ? 'Instance owner' : 'Human';
  $('#my-avatar').textContent = state.me.name.slice(0, 1).toUpperCase(); $('#composer-name').textContent = state.me.name;
  document.querySelectorAll('.owner-only').forEach(node => { node.hidden = state.me.kind !== 'owner'; });
  await refresh(); schedulePoll();
}
async function refresh() {
  state.principals = (await api('/principals')).items;
  state.threads = (await allPages('/threads')).items;
  renderThreads(); renderPrincipals();
  if (state.selected) await loadMessages();
  if (state.view === 'overview') { renderOverviewAgents(); await loadOverview(); }
  $('#sync-state').textContent = 'Updated';
}
function schedulePoll() {
  clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    if (!state.me || document.hidden) { schedulePoll(); return; }
    try { await refresh(); state.pollDelay = 30000; }
    catch (error) {
      if (error.status === 401) { state.me = null; authMode('login'); toast('Session ended. Sign in again.'); return; }
      state.pollDelay = Math.min(state.pollDelay * 2, 300000); $('#sync-state').textContent = 'Retrying later';
    }
    schedulePoll();
  }, state.pollDelay + Math.random() * 5000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) { state.pollDelay = 30000; schedulePoll(); } });
$('#logout').addEventListener('click', async () => {
  try { await api('/session', { method: 'DELETE' }); state.me = null; state.selected = null; state.messages = []; state.overviewRequest++; state.overview = []; $('#overview-feed').replaceChildren(); clearTimeout(state.timer); $('#chat-empty').hidden = false; $('#chat-active').hidden = true; authMode('login'); } catch (error) { toast(error.message); }
});
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', async () => {
  state.view = button.dataset.view; toggleMenu(false);
  for (const view of ['conversations', 'overview', 'network', 'access']) $(`#${view}`).hidden = view !== state.view;
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  if (state.view === 'overview') { renderOverviewAgents(); await loadOverview(); }
  if (state.view === 'access') try { await loadAccess(); } catch (error) { toast(error.message); }
}));
function renderOverviewAgents() {
  const select = $('#overview-agent'), value = select.value;
  select.replaceChildren(el('option', '', 'All agents')); select.firstChild.value = '';
  for (const p of state.principals.filter(p => p.kind === 'agent')) { const option = el('option', '', p.name); option.value = p.id; select.append(option); }
  select.value = value;
}
async function loadOverview(more = false) {
  const request = ++state.overviewRequest, principalId = state.me?.id;
  const params = new URLSearchParams({ limit: '50', status: $('#overview-status').value });
  if ($('#overview-agent').value) params.set('agent', $('#overview-agent').value);
  if ($('#overview-type').value) params.set('type', $('#overview-type').value);
  if (more && state.overviewCursor) params.set('before', state.overviewCursor);
  $('#overview-error').textContent = ''; $('#overview-more').disabled = true; $('#overview-feed').setAttribute('aria-busy', 'true');
  try {
    const result = await api(`/overview?${params}`);
    if (request !== state.overviewRequest || state.me?.id !== principalId) return;
    state.overview = more ? [...state.overview, ...result.items] : result.items;
    state.overviewCursor = result.next_cursor;
    $('#overview-more').hidden = !result.has_more;
    renderOverview();
  } catch (error) { if (request === state.overviewRequest) $('#overview-error').textContent = error.message; }
  finally { if (request === state.overviewRequest) { $('#overview-more').disabled = false; $('#overview-feed').setAttribute('aria-busy', 'false'); } }
}
function renderOverview() {
  const feed = $('#overview-feed'); feed.replaceChildren();
  $('#overview-caption').textContent = `${state.overview.length} recent matching messages · Newest first · Acknowledgment confirms processing, not task completion.`;
  if (!state.overview.length) feed.append(el('p', 'empty-list', 'No messages match these filters. Conversations will appear here as your agents exchange messages.'));
  for (const message of state.overview) {
    const card = el('article', 'overview-card'), header = el('header'), identity = el('div', 'overview-identity');
    const avatar = el('div', 'avatar', humanName(message.sender_id).slice(0, 1).toUpperCase()); colorAvatar(avatar, humanName(message.sender_id));
    const names = el('div'); names.append(el('strong', '', humanName(message.sender_id)), el('small', '', message.thread_title));
    identity.append(avatar, names); header.append(identity, el('time', '', `${date(message.created_at)} · ${time(message.created_at)}`)); card.append(header);
    const content = el('div', 'overview-content');
    if (message.type === 'text') content.textContent = message.content;
    else if (message.type === 'json') { content.append(el('span', 'eyebrow', 'STRUCTURED MESSAGE'), el('pre', '', JSON.stringify(message.content, null, 2))); }
    else { const link = el('a', '', message.type === 'artifact' ? `↗ ${message.content.name ?? 'Deliverable'}` : message.content); link.href = message.type === 'artifact' ? message.content.url : message.content; link.target = '_blank'; link.rel = 'noopener noreferrer'; content.append(link); }
    card.append(content);
    const recipients = message.recipients.filter(r => r.kind === 'agent'), pending = recipients.filter(r => !r.acked_at);
    const footer = el('footer'), summary = el('span', pending.length ? 'processing-state pending' : 'processing-state');
    summary.textContent = pending.length ? `Awaiting: ${pending.map(r => humanName(r.recipient_id)).join(', ')}` : recipients.length ? `✓ All ${recipients.length} Agent recipients acknowledged` : 'No Agent recipients';
    summary.title = message.recipients.map(r => `${humanName(r.recipient_id)}: ${r.acked_at ? 'acknowledged' : 'awaiting acknowledgment'}`).join('\n');
    const jump = el('button', 'text-button', 'Open conversation →');
    jump.addEventListener('click', async () => { $('[data-view="conversations"]').click(); await selectThread(message.thread_id); const target = $(`[data-message-id="${message.id}"]`); if (target) { target.scrollIntoView({ block: 'center' }); target.classList.add('spotlight'); setTimeout(() => target.classList.remove('spotlight'), 2000); } });
    footer.append(summary, jump); card.append(footer); feed.append(card);
  }
}
for (const selector of ['#overview-agent', '#overview-status', '#overview-type']) $(selector).addEventListener('change', () => loadOverview());
$('#overview-refresh').addEventListener('click', () => loadOverview());
$('#overview-more').addEventListener('click', () => loadOverview(true));
$('#thread-search').addEventListener('input', renderThreads);
function renderThreads() {
  $('#thread-count').textContent = String(state.threads.length);
  const filtered = state.threads.filter(t => t.title.toLowerCase().includes($('#thread-search').value.toLowerCase()));
  $('#thread-list').replaceChildren();
  if (!filtered.length) $('#thread-list').append(el('p', 'empty-list', state.threads.length ? 'No matching conversations.' : 'Your first conversation starts here.\nCreate an agent, then start a thread.'));
  for (const thread of [...filtered].sort((a, b) => (b.last_message_seq ?? 0) - (a.last_message_seq ?? 0))) {
    const button = el('button', 'thread-item'); button.classList.toggle('selected', thread.id === state.selected);
    const copy = el('div', 'thread-copy');
    const last = thread.last_message;
    const preview = !last ? 'Start the conversation' : last.type === 'text' ? last.content : last.type === 'artifact' ? `↗ ${last.content.name ?? 'Deliverable'}` : last.type === 'json' ? 'Structured message' : last.content;
    copy.append(el('strong', '', thread.title), el('small', '', last ? `${humanName(last.sender_id)}: ${preview}` : preview));
    const avatar = el('div', 'avatar thread-avatar', thread.title.slice(0, 2).toUpperCase()); colorAvatar(avatar, thread.title);
    button.append(avatar, copy, el('time', '', last?.created_at ? time(last.created_at) : date(thread.created_at)));
    button.addEventListener('click', () => selectThread(thread.id)); $('#thread-list').append(button);
  }
}
async function selectThread(threadId) {
  $('#conversations').classList.add('chat-open');
  state.selected = threadId; state.messages = []; state.cursor = '0';
  $('#compose-error').textContent = ''; $('#message-text').value = ''; $('#compose-form').dataset.pendingKey = ''; $('#compose-form').dataset.pendingSignature = '';
  $('#chat-empty').hidden = true; $('#chat-active').hidden = false; renderThreads(); $('#message-list').replaceChildren();
  try { await loadMessages(true); } catch (error) { toast(error.message); }
}
async function loadMessages(forceScroll = false) {
  const threadId = state.selected, cursor = state.cursor;
  const result = await allPages(`/threads/${threadId}`, cursor);
  if (state.selected !== threadId || state.cursor !== cursor) return;
  $('#chat-title').textContent = result.last.thread.title;
  $('#chat-members').textContent = `${result.last.thread.members.length} members · ${result.last.thread.members.filter(p => p.kind === 'agent').length} agents`;
  $('#chat-avatar').textContent = result.last.thread.title.slice(0, 2).toUpperCase(); colorAvatar($('#chat-avatar'), result.last.thread.title);
  state.members = result.last.thread.members;
  renderMembers();
  if (result.items.length || forceScroll) {
    state.messages.push(...result.items); state.cursor = result.next_cursor;
    renderMessages(forceScroll);
  }
  await loadActivity(threadId);
}
function renderMembers() {
  $('#thread-inspector').hidden = !state.selected || !state.inspector;
  $('#toggle-activity').setAttribute('aria-expanded', String(state.inspector)); $('#group-info').setAttribute('aria-expanded', String(state.inspector));
  $('#inspector-member-list').replaceChildren();
  for (const p of state.members) {
    const row = el('div', 'member-row'), summary = el('div');
    summary.append(el('strong', '', p.name), el('small', '', p.kind === 'agent' ? p.description || 'Agent' : p.kind === 'owner' ? 'Instance owner' : 'Human'));
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
  if (activity.length) {
    const acked = activity.reduce((n, item) => n + item.recipients.filter(r => r.acked_at).length, 0);
    const pending = activity.reduce((n, item) => n + item.recipients.filter(r => !r.acked_at).length, 0);
    const summary = el('div', 'activity-summary');
    summary.append(el('strong', '', `✓ ${acked} acknowledged`), el('small', '', `${pending} pending · last ${activity.length} messages`));
    $('#activity-list').append(summary);
  }
  if (!activity.length) $('#activity-list').append(el('p', 'fine', 'The next handoff will appear here.'));
  for (const item of activity) {
    const card = el('div', 'activity-card');
    const who = el('p'); who.append(el('strong', '', humanName(item.sender_id)), document.createTextNode(' sent a ' + (item.type === 'artifact' ? 'deliverable' : item.type === 'json' ? 'structured message' : item.type === 'url' ? 'link' : 'message')));
    card.append(el('span', 'activity-time', time(item.created_at)), who);
    const recipients = el('div', 'handoff-recipients');
    for (const recipient of item.recipients) {
      const line = el('div', `handoff-recipient${recipient.acked_at ? ' done' : ''}`);
      line.append(el('span', '', recipient.acked_at ? '✓' : '↗'), el('span', '', humanName(recipient.recipient_id)), el('small', '', recipient.acked_at ? 'acknowledged' : 'pending'));
      recipients.append(line);
    }
    card.append(recipients); const jump = el('button', 'text-button', `View message #${item.seq}`);
    jump.addEventListener('click', () => { const message = $(`[data-message-id="${item.message_id}"]`); if (message) { message.scrollIntoView({ behavior: 'smooth', block: 'center' }); message.classList.add('spotlight'); setTimeout(() => message.classList.remove('spotlight'), 2000); } });
    card.append(jump); $('#activity-list').append(card);
  }
}
$('#add-members').addEventListener('click', () => {
  const choices = state.principals.filter(p => p.active && !state.members.some(m => m.id === p.id));
  if (!choices.length) { toast('Everyone in your network is already in this group.'); return; }
  openModal('Add to the group', 'New participants can read the group’s history and receive future messages.', async data => {
    await api(`/threads/${state.selected}/members`, { method: 'POST', data: { members: data.getAll('members') } });
    $('#modal').close(); await loadMessages(); toast('Group members updated.');
  });
  const wrapper = el('div', 'check-list');
  for (const p of choices) { const label = el('label'), input = el('input'); input.type = 'checkbox'; input.name = 'members'; input.value = p.id; label.append(input, document.createTextNode(`${p.name} · ${p.kind}`)); wrapper.append(label); }
  $('#modal-fields').append(wrapper); $('#modal-submit').textContent = 'Add participants';
});
function renderMessages(forceScroll = false) {
  const list = $('#message-list'), atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  list.replaceChildren();
  if (!state.messages.length) list.append(el('p', 'empty-list', 'A fresh conversation. Send the first message.'));
  let previousDay;
  for (const message of state.messages) {
    const day = new Date(message.created_at).toLocaleDateString();
    if (day !== previousDay) { const separator = el('div', 'date-separator'); separator.append(el('span', '', date(message.created_at))); list.append(separator); previousDay = day; }
    const principal = state.principals.find(p => p.id === message.sender_id);
    const article = el('article', `message${message.sender_id === state.me.id ? ' mine' : ''}`);
    article.dataset.messageId = message.id;
    const name = principal?.name ?? message.sender_id;
    const avatar = el('div', `avatar ${principal?.kind === 'agent' ? 'agent-avatar' : 'human-avatar'}`, name.slice(0, 1).toUpperCase()); colorAvatar(avatar, name); article.append(avatar);
    const content = el('div', 'message-body'), meta = el('div', 'message-meta');
    meta.append(el('strong', '', name), el('span', 'kind-pill', principal?.kind === 'agent' ? 'AGENT' : 'HUMAN'));
    const timestamp = el('time', '', time(message.created_at)); timestamp.title = new Date(message.created_at).toLocaleString(); timestamp.dateTime = message.created_at;
    const bubble = el('div', 'bubble');
    if (message.type === 'text') bubble.textContent = message.content;
    else if (message.type === 'json') {
      bubble.classList.add('structured-message');
      bubble.append(el('span', 'eyebrow', 'STRUCTURED MESSAGE'));
      if (message.content && typeof message.content === 'object' && !Array.isArray(message.content)) {
        const rows = el('dl', 'json-fields');
        for (const [key, value] of Object.entries(message.content)) { rows.append(el('dt', '', key.replaceAll('_', ' ')), el('dd', '', typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value))); }
        bubble.append(rows);
      } else bubble.append(el('pre', '', JSON.stringify(message.content, null, 2)));
      const details = el('details'), summary = el('summary', '', 'View raw JSON'); details.append(summary, el('pre', '', JSON.stringify(message.content, null, 2))); bubble.append(details);
    }
    else {
      const link = el('a', '', message.type === 'artifact' ? message.content.name ?? message.content.url : message.content);
      link.href = message.type === 'artifact' ? message.content.url : message.content; link.target = '_blank'; link.rel = 'noopener noreferrer'; bubble.append(link);
      if (message.type === 'artifact') { bubble.classList.add('artifact-message'); bubble.prepend(el('span', 'artifact-icon', '↗'), el('span', 'eyebrow', 'DELIVERABLE')); }
    }
    const footer = el('div', 'message-id'); footer.append(timestamp);
    const receipts = el('button', 'receipt-button', '↗'); receipts.type = 'button'; receipts.title = 'Delivery details'; receipts.setAttribute('aria-label', 'Delivery details');
    receipts.addEventListener('click', async () => {
      try {
        const result = await api(`/messages/${message.id}`);
        const summary = result.receipts.map(r => `${humanName(r.recipient_id)}: ${r.acked_at ? 'acknowledged ' + time(r.acked_at) : 'awaiting acknowledgment'}`).join('\n');
        openModal('Delivery details', `Message #${message.seq}. Acknowledgment means the recipient explicitly confirmed processing.`, async () => { $('#modal').close(); });
        $('#modal-fields').append(el('p', 'key-hint', summary || 'No recipients.'));
        const mine = result.receipts.find(r => r.recipient_id === state.me.id);
        if (mine && !mine.acked_at) {
          state.modalAction = async () => { await api(`/messages/${message.id}/ack`, { method: 'POST' }); $('#modal').close(); await loadMessages(); toast('Message acknowledged.'); };
          $('#modal-submit').textContent = 'Acknowledge processing';
        } else $('#modal-submit').textContent = 'Close';
      } catch (error) { toast(error.message); }
    });
    footer.append(receipts); bubble.prepend(meta); bubble.append(footer); content.append(bubble); article.append(content); list.append(article);
  }
  if (atBottom || forceScroll) list.scrollTop = list.scrollHeight;
}
$('#compose-form').addEventListener('submit', async event => {
  event.preventDefault(); const threadId = state.selected, content = $('#message-text').value;
  if (!content.trim() || !threadId) return;
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
function startThread(preselected) {
  if (!state.principals.some(p => p.id !== state.me.id && p.active)) { toast('Create an agent or invite another person first.'); $('[data-view="network"]').click(); return; }
  openModal('Start a conversation', 'Choose who receives messages in this thread. Humans can observe every thread.', async data => {
    const result = await api('/threads', { method: 'POST', data: { title: data.get('title'), members: data.getAll('members') } });
    $('#modal').close(); await refresh(); $('[data-view="conversations"]').click(); await selectThread(result.thread.id);
  });
  field('Conversation title', 'title', 'e.g. Ship the landing page');
  const wrapper = el('div', 'check-list');
  for (const principal of state.principals.filter(p => p.id !== state.me.id && p.active)) {
    const label = el('label'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.name = 'members'; checkbox.value = principal.id; checkbox.checked = principal.id === preselected;
    label.append(checkbox, document.createTextNode(`${principal.name} · ${principal.kind}`)); wrapper.append(label);
  }
  $('#modal-fields').append(el('p', 'fine', 'Participants (choose at least one)'), wrapper);
}
$('#new-thread').addEventListener('click', () => startThread()); $('#empty-start').addEventListener('click', () => startThread());
async function showAgentConnection(principal, token) {
  const ownerId = state.principals.find(p => p.kind === 'owner')?.id ?? state.me.id;
  const instructions = connectionInstructions({ url: location.origin + appBase, principal, token, ownerId });
  await showSecret(`连接 ${principal.name}`, '复制下面整段内容给你的 Agent。客户端和指南直接来自这个私有实例，不需要公开仓库。', instructions, `Agent ID: ${principal.id}\nKey ID: ${token.id}\n仅限此 Agent 权限；可在 Access & invites 撤销。`, { copyLabel: '复制接入指令给 Agent', savedLabel: ' 我已保存接入指令或交给这个 Agent' });
}
$('#create-agent').addEventListener('click', () => {
  openModal('Create an agent', 'Give your agent an identity and its own mailbox.', async data => {
    const result = await api('/agents', { method: 'POST', data: { name: data.get('name'), description: data.get('description') } });
    await showAgentConnection(result.principal, result.token);
    await refresh(); toast('Agent created. Start a conversation to give it some work.');
  });
  field('Agent name', 'name', 'e.g. Codex'); field('What does it do?', 'description', 'e.g. Turns plans into working code').required = false;
});
function renderPrincipals() {
  $('#principal-grid').replaceChildren();
  for (const p of state.principals) {
    const card = el('article', 'principal-card'), top = el('div', 'principal-top');
    top.append(el('div', `avatar ${p.kind === 'agent' ? 'agent-avatar' : 'human-avatar'}`, p.name.slice(0, 1).toUpperCase()), el('span', `badge${p.active ? '' : ' off'}`, p.active ? (p.kind === 'agent' ? 'AGENT' : p.kind === 'owner' ? 'OWNER' : 'HUMAN') : 'DISABLED'));
    card.append(top, el('h2', '', p.name), el('p', '', p.description || (p.kind === 'agent' ? 'Ready for the next handoff.' : 'Can observe and join the conversation.')), el('code', '', p.id));
    const footer = el('footer');
    if (state.me.kind === 'owner' && p.kind === 'agent' && p.active) {
      const connect = el('button', 'primary', '连接 Agent'); connect.dataset.connectAgent = p.id;
      connect.addEventListener('click', async () => {
        connect.disabled = true;
        try { const result = await api('/tokens', { method: 'POST', data: { principal_id: p.id, label: 'Agent connection kit' } }); await showAgentConnection(p, result.token); }
        catch (error) { toast(error.message); } finally { connect.disabled = false; }
      }); footer.append(connect);
    }
    if (p.id !== state.me.id && p.active) { const message = el('button', 'secondary', 'Message ↗'); message.addEventListener('click', () => startThread(p.id)); footer.append(message); }
    if (state.me.kind === 'owner' && p.kind !== 'owner') {
      const disable = el('button', 'text-button', p.active ? 'Disable' : 'Enable');
      disable.addEventListener('click', async () => {
        if (p.active && !confirm(`Disable ${p.name} and revoke all of their keys?`)) return;
        try { await api(`/principals/${p.id}`, { method: 'PATCH', data: { active: !p.active } }); await refresh(); } catch (error) { toast(error.message); }
      }); footer.append(disable);
    }
    card.append(footer); $('#principal-grid').append(card);
  }
}
async function loadAccess() {
  const tokens = (await api('/tokens')).items; $('#token-list').replaceChildren();
  for (const token of tokens) {
    const row = el('tr'); row.append(el('td', '', token.label), el('td', '', token.principal_name), el('td', '', token.revoked_at ? 'Revoked' : 'Active'));
    const action = el('td');
    if (!token.revoked_at) {
      const revoke = el('button', 'secondary', 'Revoke');
      revoke.addEventListener('click', async () => { if (!confirm(`Revoke “${token.label}”?`)) return; try { await api(`/tokens/${token.id}`, { method: 'DELETE' }); await loadAccess(); toast('Key revoked.'); } catch (error) { toast(error.message); } }); action.append(revoke);
    }
    row.append(action); $('#token-list').append(row);
  }
  if (state.me.kind === 'owner') {
    const invites = (await api('/invites')).items; $('#invite-list').replaceChildren();
    if (!invites.length) $('#invite-list').append(el('p', 'fine', 'No invitations yet. Invite a person to share your network.'));
    for (const invite of invites) {
      const row = el('div', 'invite-row'), summary = el('div', '', invite.claimed_by ? 'Accepted' : invite.revoked_at ? 'Revoked' : new Date(invite.expires_at) < new Date() ? 'Expired' : 'Waiting to be accepted');
      summary.append(el('small', '', `Expires ${new Date(invite.expires_at).toLocaleString()}`)); row.append(summary);
      if (!invite.revoked_at && !invite.claimed_by && new Date(invite.expires_at) > new Date()) {
        const revoke = el('button', 'secondary', 'Revoke'); revoke.addEventListener('click', async () => { try { await api(`/invites/${invite.id}`, { method: 'DELETE' }); await loadAccess(); } catch (error) { toast(error.message); } }); row.append(revoke);
      }
      $('#invite-list').append(row);
    }
  }
}
$('#create-key').addEventListener('click', () => {
  openModal('Create an access key', 'Create a replacement or a key for another client.', async data => {
    const result = await api('/tokens', { method: 'POST', data: { principal_id: data.get('principal'), label: data.get('label') } });
    await showSecret('Save your new key', 'This key is shown only once.', result.token.token); await loadAccess();
  });
  field('Key label', 'label', 'e.g. Laptop / nightly worker');
  const select = field('Identity', 'principal', '', 'select');
  for (const p of state.principals.filter(p => p.active && (state.me.kind === 'owner' || p.id === state.me.id))) { const option = el('option', '', `${p.name} · ${p.kind}`); option.value = p.id; select.append(option); }
  select.value = state.me.id;
});
$('#invite-human').addEventListener('click', async () => {
  try { const result = await api('/invites', { method: 'POST', data: {} }); await showSecret('Invite someone in', 'Send this private link to a person you trust. Valid for 24 hours, once.', `${location.origin}${appBase}/#invite=${result.invite.code}`); await loadAccess(); } catch (error) { toast(error.message); }
});
$('#export-history').addEventListener('click', async () => {
  $('#export-history').disabled = true;
  try {
    const messages = (await allPages('/export')).items;
    const blob = new Blob([JSON.stringify({ instance: location.origin, exported_at: new Date().toISOString(), principals: state.principals, threads: state.threads, messages }, null, 2)], { type: 'application/json' });
    const link = el('a'); link.href = URL.createObjectURL(blob); link.download = `agent-gram-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); toast('Message history exported.');
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
boot();
