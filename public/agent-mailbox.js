export const mailboxContent = message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2);

export function createAgentMailbox({ root, api, t, locale, avatar, openConversation, onBack, onUnauthorized }) {
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const user = (tag, cls, text) => { const n = el(tag, cls, text); n.dataset.userContent = ''; return n; };
  const button = (label, cls, action) => { const b = el('button', cls, label); b.type = 'button'; b.addEventListener('click', action); return b; };
  let agent = null, items = [], totals = {}, status = 'pending', selected = null, cursor = null, more = false, loading = false, failed = false, generation = 0, searchTimer, renderedLocale;
  const back = button(t('All Agents'), 'mailbox-back text-button', () => { reset(); onBack(); });
  const header = el('header', 'mailbox-header'), identity = el('div', 'mailbox-identity'), heading = el('div');
  const eyebrow = el('span', 'mailbox-eyebrow', t('Agent mailbox')), title = user('h2', '', ''); heading.append(eyebrow, title); identity.append(heading);
  const refresh = button(t('Refresh'), 'secondary', () => void load()); header.append(identity, refresh);
  const caption = el('p', 'mailbox-caption', t('A read-only view of messages delivered to this Agent. Opening a message does not acknowledge it.'));
  const toolbar = el('div', 'mailbox-toolbar'), tabs = el('div', 'mailbox-tabs'), search = el('input');
  tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', t('Delivery status'));
  search.type = 'search'; search.maxLength = 200; search.placeholder = t('Search messages, people or conversations'); search.setAttribute('aria-label', search.placeholder);
  search.addEventListener('input', () => { clearTimeout(searchTimer); generation++; loading = false; items = []; more = false; clearSelection(); searchTimer = setTimeout(() => void load(), 250); });
  toolbar.append(tabs, search);
  const notice = el('p', 'mailbox-notice'); notice.setAttribute('role', 'status'); notice.hidden = true;
  const workspace = el('div', 'mailbox-workspace'), listPane = el('section', 'mailbox-list-pane');
  listPane.setAttribute('aria-label', t('Delivered messages'));
  const listHeading = el('div', 'mailbox-list-heading'), listLabel = el('span', '', t('Newest first')), resultCount = el('span'); listHeading.append(listLabel, resultCount);
  const list = el('div', 'mailbox-messages'), empty = el('div', 'mailbox-empty'); empty.setAttribute('role', 'status');
  const loadMore = button(t('Load older messages'), 'secondary mailbox-more', () => void load(true));
  const reader = el('section', 'mailbox-reader'); reader.setAttribute('aria-label', t('Message details'));
  listPane.append(listHeading, list, empty, loadMore); workspace.append(listPane, reader);
  root.append(back, header, caption, toolbar, notice, workspace);
  const date = value => new Date(value).toLocaleString(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const badge = m => el('span', `mailbox-badge ${m.acked_at ? 'is-acked' : 'is-pending'}`, t(m.acked_at ? 'Acknowledged' : 'Pending'));
  const conversation = m => m.thread_kind === 'direct' ? t('Direct conversation') : m.thread_title;
  function clearSelection() { selected = null; workspace.classList.remove('is-reading'); }
  function renderReader() {
    reader.replaceChildren();
    const m = items.find(item => item.id === selected);
    if (!m) {
      const icon = el('div', 'mailbox-empty-icon', '↙'); icon.setAttribute('aria-hidden', 'true');
      const placeholder = el('div', 'mailbox-reader-placeholder'); placeholder.append(icon, el('h3', '', t('Every delivery, in one place')), el('p', '', t('Choose a message to read its content and delivery details.'))); reader.append(placeholder); return;
    }
    const mobileBack = button(t('Back to messages'), 'text-button mailbox-reader-back', () => { clearSelection(); render(); list.querySelector(`[data-mailbox-message="${m.id}"]`)?.focus(); });
    const top = el('div', 'mailbox-reader-top'); top.append(mobileBack, badge(m));
    const author = el('div', 'mailbox-author'); author.append(avatar({ id: m.sender_id, name: m.sender_name, avatar: m.sender_avatar }), user('h3', '', m.sender_name));
    const context = el('div', 'mailbox-context'); context.append(user('span', '', conversation(m)), el('time', '', date(m.created_at)));
    const body = user('div', 'mailbox-body', mailboxContent(m)); if (m.type === 'json' || typeof m.content !== 'string') body.classList.add('is-json');
    const metadata = el('dl', 'mailbox-metadata');
    for (const [label, value] of [[t('Delivered to'), agent.name], [t('Received'), new Date(m.created_at).toLocaleString(locale())], [t('Acknowledgment'), m.acked_at ? new Date(m.acked_at).toLocaleString(locale()) : t('Awaiting Agent processing')]]) {
      const row = el('div'); row.append(el('dt', '', label), user('dd', '', value)); metadata.append(row);
    }
    const footer = el('footer', 'mailbox-reader-footer');
    footer.append(button(t('Open conversation'), 'primary', () => void openConversation({ ...agent, oldest_pending: { thread_id: m.thread_id } }).catch(() => { notice.textContent = t('Could not open this conversation. Try again.'); notice.hidden = false; })));
    reader.append(top, author, context, body, metadata, footer);
  }
  function render() {
    renderedLocale = locale();
    back.textContent = t('All Agents'); eyebrow.textContent = t('Agent mailbox'); refresh.textContent = t('Refresh');
    caption.textContent = t('A read-only view of messages delivered to this Agent. Opening a message does not acknowledge it.');
    search.placeholder = t('Search messages, people or conversations'); search.setAttribute('aria-label', search.placeholder);
    listLabel.textContent = t('Newest first'); tabs.setAttribute('aria-label', t('Delivery status'));
    listPane.setAttribute('aria-label', t('Delivered messages')); reader.setAttribute('aria-label', t('Message details'));
    title.textContent = agent?.name ?? ''; refresh.disabled = loading; loadMore.disabled = loading;
    const previousAvatar = identity.querySelector('.avatar'); previousAvatar?.remove();
    if (agent) identity.prepend(avatar(agent));
    const focusedStatus = document.activeElement?.dataset.mailboxStatus;
    tabs.replaceChildren();
    for (const [key, label, count] of [['pending', 'Pending', totals.pending], ['acked', 'Acknowledged', totals.acked], ['all', 'All messages', totals.total]]) {
      const b = button('', 'mailbox-tab', () => { if (status === key) return; status = key; items = []; more = false; clearSelection(); void load(); });
      b.dataset.mailboxStatus = key; b.setAttribute('aria-pressed', String(status === key));
      b.append(el('span', '', t(label)), el('span', 'mailbox-tab-count', count === undefined ? '—' : String(count))); tabs.append(b);
    }
    if (focusedStatus) [...tabs.children].find(b => b.dataset.mailboxStatus === focusedStatus)?.focus({ preventScroll: true });
    const focusedMessage = document.activeElement?.dataset.mailboxMessage;
    list.replaceChildren();
    for (const m of items) {
      const row = button('', 'mailbox-message' + (selected === m.id ? ' selected' : ''), () => { selected = m.id; workspace.classList.add('is-reading'); render(); reader.querySelector('button')?.focus(); });
      row.dataset.mailboxMessage = m.id; row.setAttribute('aria-pressed', String(selected === m.id));
      const top = el('span', 'mailbox-message-top'); top.append(user('strong', '', m.sender_name), el('time', '', date(m.created_at)));
      const preview = mailboxContent(m); const bottom = el('span', 'mailbox-message-bottom'); bottom.append(user('span', '', conversation(m)), badge(m));
      row.append(top, user('span', 'mailbox-preview', preview.length > 240 ? preview.slice(0, 240) + '…' : preview), bottom); list.append(row);
    }
    if (focusedMessage) [...list.children].find(n => n.dataset.mailboxMessage === focusedMessage)?.focus({ preventScroll: true });
    listPane.setAttribute('aria-busy', String(loading)); resultCount.textContent = items.length ? t('{0} loaded', items.length) : '';
    empty.hidden = items.length > 0; empty.replaceChildren();
    if (!items.length) {
      const icon = el('div', 'mailbox-empty-icon', loading ? '···' : '✓'); icon.setAttribute('aria-hidden', 'true');
      empty.append(icon, el('h3', '', t(loading ? 'Loading messages…' : failed ? 'Messages unavailable' : search.value ? 'No matching messages' : status === 'pending' ? 'All caught up' : 'No messages yet')),
        el('p', '', t(failed ? 'Try refreshing the mailbox.' : search.value ? 'Try another name or a few words from the message.' : status === 'pending' ? 'There are no deliveries waiting for this Agent. Browse acknowledged messages to see past activity.' : 'Delivered messages will appear here.')));
    }
    loadMore.hidden = !more; loadMore.textContent = t(loading ? 'Loading messages…' : 'Load older messages');
    renderReader();
  }
  async function load(append = false) {
    if (!agent || append && loading) return;
    clearTimeout(searchTimer);
    const request = ++generation, id = agent.id;
    loading = true; failed = false; notice.hidden = true;
    render();
    const params = new URLSearchParams({ status, limit: '30' });
    if (append && cursor) params.set('before', cursor);
    if (search.value.trim()) params.set('q', search.value.trim());
    try {
      const result = await api(`/agents/${encodeURIComponent(id)}/mailbox?${params}`);
      if (request !== generation) return;
      agent = result.agent; totals = result.totals;
      items = append ? [...items, ...result.items.filter(m => !items.some(old => old.id === m.id))] : result.items;
      cursor = result.next_cursor; more = result.has_more;
    } catch (error) {
      if (request !== generation) return;
      failed = true; notice.textContent = t('Mailbox could not be refreshed. Try again.'); notice.hidden = false;
      if (error.status === 401) onUnauthorized?.();
    } finally { if (request === generation) { loading = false; render(); } }
  }
  function reset() { generation++; clearTimeout(searchTimer); agent = null; items = []; totals = {}; cursor = null; more = false; failed = false; loading = false; clearSelection(); root.hidden = true; }
  return { open(p) { reset(); agent = p; status = 'pending'; search.value = ''; root.hidden = false; void load(); }, reset,
    render() { if (!root.hidden && renderedLocale !== locale()) render(); } };
}
