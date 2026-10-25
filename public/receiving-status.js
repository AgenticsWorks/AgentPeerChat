import { createChatSync } from './chat-sync.js';
import { createAgentMailbox } from './agent-mailbox.js';

export const notificationLabel = state => ({ connected: 'Connected', connecting: 'Awaiting heartbeat', stale: 'Heartbeat stale', disconnected: 'Not connected', unknown: 'Unknown', unsupported: 'Not supported', disabled: 'Disabled' })[state] ?? 'Unknown';
export function receivingSummary(items) {
  const active = items.filter(p => p.active);
  return { enabled: active.length, connected: active.filter(p => p.notification.state === 'connected').length,
    pending: active.reduce((n, p) => n + p.pending_count, 0), unknown: active.filter(p => p.notification.state === 'unknown').length };
}

export function createReceivingPage({ root, api, t, locale, avatar, openConversation, onUnauthorized }) {
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  const button = (text, className, action) => { const n = el('button', className, text); n.type = 'button'; n.addEventListener('click', action); return n; };
  let uncertain = false;
  let data = null, selected = null, filter = 'all', syncState = { status: 'idle' };
  const header = el('header', 'receiving-header'), heading = el('div'), title = el('h1'), subtitle = el('p', 'fine');
  const actions = el('div', 'receiving-actions'), freshness = el('span', 'fine'); freshness.setAttribute('role', 'status');
  const refresh = button('', 'secondary', () => void sync.refresh().catch(() => {}));
  heading.append(title, subtitle); actions.append(freshness, refresh); header.append(heading, actions);
  const error = el('p', 'receiving-error'); error.setAttribute('role', 'status'); error.hidden = true;
  const stats = el('div', 'receiving-stats'), layout = el('div', 'receiving-layout'), list = el('section', 'receiving-list');
  const toolbar = el('div', 'receiving-toolbar'), search = el('input'), filters = el('div', 'receiving-filters');
  search.type = 'search'; search.addEventListener('input', renderRows); toolbar.append(search, filters);
  const scroll = el('div', 'receiving-scroll'), table = el('table'), thead = el('thead'), tbody = el('tbody');
  table.append(thead, tbody); scroll.append(table);
  const empty = el('p', 'receiving-empty'), hint = el('p', 'receiving-hint fine'); empty.setAttribute('role', 'status');
  list.append(toolbar, scroll, empty, hint);
  const detail = el('aside', 'receiving-detail'); detail.hidden = true; detail.setAttribute('aria-label', t('Agent details'));
  layout.append(list, detail); root.append(header, error, stats, layout);
  const mailboxRoot = el('section', 'agent-mailbox'); mailboxRoot.hidden = true; root.append(mailboxRoot);
  const mailbox = createAgentMailbox({ root: mailboxRoot, api, t, locale, avatar, openConversation, onUnauthorized,
    onBack: () => { header.hidden = stats.hidden = layout.hidden = false; render(); [...tbody.querySelectorAll('button')].find(b => b.dataset.receivingAgent === selected)?.focus(); } });
  function openMailbox(p) { header.hidden = stats.hidden = layout.hidden = true; mailbox.open(p); mailboxRoot.querySelector('button')?.focus(); }
  const stale = () => uncertain;
  const items = () => (data?.items ?? []).map(p => stale() && p.active ? { ...p, notification: { state: 'unknown', last_heartbeat_at: null } } : p);
  function relative(value) {
    if (!value) return t('Not recorded');
    // Anchor to the server clock, not an owner's potentially skewed device clock.
    const seconds = Math.max(0, Math.floor((Date.parse(data.observed_at) - Date.parse(value)) / 1000));
    if (seconds < 60) return t('{0} seconds ago', seconds);
    if (seconds < 3600) return t('{0} minutes ago', Math.floor(seconds / 60));
    if (seconds < 86400) return t('{0} hours ago', Math.floor(seconds / 3600));
    return t('{0} days ago', Math.floor(seconds / 86400));
  }
  function stamp(value) {
    const node = el('span', '', relative(value));
    if (value) node.title = new Date(value).toLocaleString(locale());
    return node;
  }
  function renderRows() {
    const focusId = document.activeElement?.dataset.receivingAgent;
    const visible = items().filter(p => (!search.value || p.name.toLowerCase().includes(search.value.toLowerCase()))
      && (filter === 'all' || filter === 'disabled' && !p.active || filter === 'attention' && p.active && p.pending_count > 0));
    tbody.replaceChildren();
    for (const p of visible) {
      const row = el('tr', `${p.id === selected ? 'selected ' : ''}${!p.active ? 'receiving-disabled' : ''}`);
      const name = el('td'), nameButton = button('', 'receiving-agent', () => { selected = p.id; renderRows(); renderDetail(); });
      nameButton.dataset.receivingAgent = p.id; nameButton.setAttribute('aria-expanded', String(selected === p.id));
      const label = el('span'); const strong = el('strong', '', p.name); strong.dataset.userContent = '';
      label.append(strong, el('small', '', t(p.active ? 'Enabled' : 'Disabled'))); nameButton.append(avatar(p), label); name.append(nameButton);
      const transport = el('td'), badge = el('span', `receiving-transport ${p.notification.state}`, t(notificationLabel(p.notification.state)));
      transport.append(badge);
      if (p.notification.last_heartbeat_at) transport.append(el('small', '', t('Heartbeat {0}', relative(p.notification.last_heartbeat_at))));
      const checked = el('td'); checked.append(stamp(p.last_checked_at));
      const pending = el('td'); pending.append(el('span', p.active && p.pending_count ? 'receiving-pending' : '', String(p.pending_count)));
      if (p.oldest_pending) pending.append(el('small', '', t('Oldest: {0}', relative(p.oldest_pending.created_at))));
      const ack = el('td'); ack.append(stamp(p.last_ack_at));
      const action = el('td'); const view = button(t('View mailbox'), 'secondary receiving-mailbox-button', () => { selected = p.id; openMailbox(p); });
      view.dataset.mailboxAgent = p.id; view.setAttribute('aria-label', t('View mailbox for {0}', p.name)); action.append(view);
      row.append(name, transport, checked, pending, ack, action); tbody.append(row);
    }
    empty.hidden = visible.length > 0;
    empty.textContent = !data ? t('Loading receiving status…') : data.items.length ? t('No Agents match this filter.') : t('No Agents connected yet. Connect an Agent from Chats.');
    if (focusId) [...tbody.querySelectorAll('button')].find(n => n.dataset.receivingAgent === focusId)?.focus({ preventScroll: true });
  }
  function renderDetail() {
    const focusedAction = detail.contains(document.activeElement) ? document.activeElement?.dataset.receivingAction : null;
    const p = items().find(p => p.id === selected); detail.hidden = !p; layout.classList.toggle('has-detail', !!p); detail.replaceChildren();
    if (!p) return;
    const top = el('header'), name = el('h2', '', p.name); name.dataset.userContent = '';
    const close = button('×', 'icon-button', () => { const id = selected; selected = null; renderRows(); renderDetail(); [...tbody.querySelectorAll('button')].find(n => n.dataset.receivingAgent === id)?.focus(); });
    close.dataset.receivingAction = 'close'; close.setAttribute('aria-label', t('Close details')); top.append(avatar(p), name, close); detail.append(top);
    detail.append(el('span', p.active && p.pending_count ? 'receiving-pending' : 'fine', t(!p.active ? 'Disabled' : p.pending_count ? 'Awaiting processing' : 'No pending messages')));
    if (p.oldest_pending) detail.append(el('h3', 'receiving-wait', t('{0} pending · oldest {1}', p.pending_count, relative(p.oldest_pending.created_at))));
    detail.append(el('p', 'fine', t('Connection and processing are separate. These are the latest observations, not a model health guarantee.')));
    const timeline = el('dl', 'receiving-timeline');
    for (const [label, value] of [[p.oldest_pending ? 'Oldest pending message saved' : 'Pending messages', p.oldest_pending?.created_at], ['Last inbox check', p.last_checked_at], ['Last sent message', p.last_sent_at], ['Last acknowledgment', p.last_ack_at]]) {
      const row = el('div'); row.append(el('dt', '', t(label))); const dd = el('dd');
      if (label === 'Pending messages') dd.textContent = '0'; else dd.append(stamp(value));
      row.append(dd); timeline.append(row);
    }
    detail.append(timeline);
    const config = el('section', 'receiving-config'); config.append(el('h3', '', t('Receiving configuration')));
    for (const label of ['Receiving mode', 'Fallback interval']) { const row = el('p'); row.append(el('span', '', t(label)), el('span', '', t('Not reported'))); config.append(row); }
    detail.append(config, el('p', 'fine', t('Check the receiving task on the Agent’s host platform.')));
    const open = button(t(p.oldest_pending ? 'Open pending conversation' : 'Open conversation'), 'primary', () => void openConversation(p).catch(e => { error.textContent = e.message; error.hidden = false; }));
    open.dataset.receivingAction = 'open'; detail.append(open);
    const viewMailbox = button(t('View mailbox'), 'secondary', () => openMailbox(p)); detail.append(viewMailbox);
    if (focusedAction) [...detail.querySelectorAll('button')].find(n => n.dataset.receivingAction === focusedAction)?.focus({ preventScroll: true });
  }
  function render() {
    title.textContent = t('Agent receiving status'); subtitle.textContent = t('Notification connections, inbox checks and message processing.');
    refresh.textContent = t('Refresh'); refresh.disabled = syncState.status === 'syncing';
    freshness.textContent = data ? t('Observed at {0}', new Date(data.observed_at).toLocaleTimeString(locale())) : t('Loading receiving status…');
    error.hidden = !stale(); error.textContent = t('Status could not be refreshed. Previous records are stale; current connections are unknown.');
    search.placeholder = t('Search Agents'); search.setAttribute('aria-label', t('Search Agents'));
    const summary = receivingSummary(items()); stats.replaceChildren();
    for (const [label, key] of [['Enabled Agents', 'enabled'], ['Realtime connections', 'connected'], ['Pending messages', 'pending'], ['Unknown status', 'unknown']]) {
      const card = el('div', 'receiving-stat'); card.append(el('span', 'fine', t(label)), el('strong', key === 'pending' && summary[key] ? 'receiving-amber' : '', data ? String(summary[key]) : '—')); stats.append(card);
    }
    const focusedFilter = document.activeElement?.dataset.receivingFilter;
    filters.replaceChildren();
    for (const [key, label, count] of [['all', 'All Agents', data?.items.length ?? 0], ['attention', 'Needs attention', items().filter(p => p.active && p.pending_count > 0).length], ['disabled', 'Disabled', items().filter(p => !p.active).length]]) {
      const b = button(`${t(label)} ${count}`, 'secondary', () => { filter = key; render(); }); b.dataset.receivingFilter = key;
      b.setAttribute('aria-pressed', String(filter === key)); filters.append(b);
    }
    if (focusedFilter) [...filters.children].find(b => b.dataset.receivingFilter === focusedFilter)?.focus({ preventScroll: true });
    const headers = el('tr'); for (const text of ['Agent', 'Realtime notifications', 'Last inbox check', 'Pending messages', 'Last acknowledgment', 'Mailbox']) { const th = el('th', '', t(text)); th.scope = 'col'; headers.append(th); } thead.replaceChildren(headers);
    hint.textContent = t('Not connected does not mean offline. ACK confirms handling, not task correctness. Inbox check times may lag by up to 30 seconds.');
    detail.setAttribute('aria-label', t('Agent details')); renderRows(); renderDetail(); mailbox.render();
  }
  const sync = createChatSync({ baseDelay: 15000, random: () => 0,
    refresh: async current => { const result = await api('/agents/receiving'); if (current()) { data = result; uncertain = false; } },
    onState: value => { syncState = value; if (['retrying', 'offline', 'paused'].includes(value.status) || value.status === 'idle' && data) uncertain = true; render(); }, onUnauthorized
  });
  return { start() { void sync.start().catch(() => {}); }, stop: sync.stop,
    reset() { mailbox.reset(); header.hidden = stats.hidden = layout.hidden = false; uncertain = false; data = null; selected = null; filter = 'all'; search.value = ''; sync.stop(); },
    availabilityChanged: sync.availabilityChanged, render };
}
