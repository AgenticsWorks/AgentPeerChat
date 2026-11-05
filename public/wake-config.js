import { createChatSync } from './chat-sync.js';

export function privateWakeTransport(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' || parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname); } catch { return false; }
}

export const verificationLabel = state => ({ not_started: 'Not tested yet', waiting: 'Waiting for the Agent', replied: 'Reply received · awaiting ACK', acked: 'ACK received · awaiting reply', verified: 'Reply and ACK verified' })[state] ?? 'Not tested yet';
export const wakeStatusLabel = state => ({ ready: 'Ready to notify', queued: 'Notification queued', sending: 'Notifying routine', retrying: 'Retry scheduled', accepted: 'Trigger accepted', idle: 'No pending messages', failed: 'Notification failed', invalid: 'Check private configuration', unsupported: 'Not supported', disabled: 'Disabled', unknown: 'Unknown' })[state] ?? 'Unknown';

// This pane holds credentials only in the current password inputs. Status polling
// updates separate nodes; it never rebuilds a focused form or saves its values.
export function createWakeConfig({ root, api, t, locale, avatar, onBack, onUnauthorized, openConversation }) {
  const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; };
  let agent = null, data = null, generation = 0, busy = false, editing = false, initialized = false, stale = false, testKey = null, mutationRevision = 0;
  let nodes = {}, translations = [], feedbackKey = '', errorKey = '';
  const text = (tag, className, key) => { const n = el(tag, className, t(key)); translations.push([n, key]); return n; };
  const button = (key, className, action) => { const n = text('button', className, key); n.type = 'button'; n.addEventListener('click', action); return n; };
  const path = () => '/agents/' + encodeURIComponent(agent.id) + '/wake';
  const clearSecrets = () => { if (nodes.url) nodes.url.value = ''; if (nodes.token) nodes.token.value = ''; };
  function close() { generation++; clearSecrets(); sync.stop(); agent = null; data = null; testKey = null; busy = false; nodes = {}; translations = []; root.replaceChildren(); root.hidden = true; }
  function formField(key, name, maxLength) {
    const label = el('label', 'wake-field', t(key)), input = el('input');
    input.type = 'password'; input.name = name; input.id = 'wake-' + name; input.required = true; input.maxLength = maxLength;
    input.autocomplete = 'new-password'; input.spellcheck = false; input.autocapitalize = 'none'; input.setAttribute('data-1p-ignore', '');
    label.htmlFor = input.id; label.append(input); return { label, input };
  }
  function step(number, title) {
    const section = el('section', 'wake-card'), heading = el('div', 'wake-card-heading');
    heading.append(el('span', 'wake-step-number', String(number)), text('h3', '', title)); section.append(heading); return section;
  }
  function build() {
    root.replaceChildren(); translations = [];
    const back = button('Back to receiving status', 'secondary mailbox-back', () => { close(); onBack(); });
    const header = el('header', 'wake-header'), identity = el('div', 'mailbox-identity'), heading = el('div');
    heading.append(text('div', 'mailbox-eyebrow', 'PRIVATE RECEIVING SETUP'));
    const name = el('h2', '', agent.name); name.dataset.userContent = ''; heading.append(name); identity.append(avatar(agent), heading);
    const headerActions = el('div', 'wake-actions');
    nodes.refresh = button('Refresh', 'secondary', () => void sync.refresh().catch(() => {}));
    headerActions.append(text('span', 'wake-private-badge', 'Owner only'), nodes.refresh); header.append(identity, headerActions);
    const intro = text('p', 'wake-intro', 'Wake Grok Bot when a message arrives. Keep your identity and existing fallback task.');
    nodes.notice = el('p', 'wake-notice'); nodes.notice.setAttribute('role', 'status'); nodes.notice.hidden = true;
    nodes.error = el('p', 'wake-error'); nodes.error.setAttribute('role', 'alert'); nodes.error.hidden = true;
    nodes.feedback = el('p', 'wake-feedback'); nodes.feedback.setAttribute('role', 'status'); nodes.feedback.hidden = true;
    const steps = el('div', 'wake-steps');
    const routine = step(1, 'Prepare your native routine');
    routine.append(text('p', 'wake-description', 'Ask Grok Bot to run agentpeerchat wake setup --runtime grokbot in your conversation. It should create or reuse one webhook receiving Routine, while preserving your existing fallback schedule.'));
    routine.append(text('p', 'fine', 'Open that Routine in Grok Bot and copy its webhook URL and sender key. Grok Bot’s native tools do not return these credentials.'));
    const providerDocs = text('a', 'wake-help-link', 'Open Grok Bot webhook guide'); providerDocs.href = 'https://docs.x.ai/grok-bot/skills-routines-and-automations#webhooks'; providerDocs.target = '_blank'; providerDocs.rel = 'noreferrer noopener'; routine.append(providerDocs);
    const credentials = step(2, 'Save private credentials');
    nodes.saved = el('div', 'wake-saved');
    nodes.saved.append(text('strong', '', 'Credentials saved privately'), text('p', 'fine', 'The URL and sender key are write-only here. They are never included in status responses.'));
    nodes.operator = text('p', 'fine', 'This Agent currently uses operator-provided credentials. Saving here replaces them for this Agent.');
    nodes.replace = button('Replace credentials', 'secondary', () => { editing = true; clearSecrets(); render(); nodes.url.focus(); });
    nodes.disconnect = button('Disconnect webhook', 'secondary', () => { nodes.removeConfirm.hidden = false; nodes.removeButton.focus(); });
    const savedActions = el('div', 'wake-actions'); savedActions.append(nodes.replace, nodes.disconnect); nodes.saved.append(nodes.operator, savedActions);
    nodes.removeConfirm = el('div', 'wake-remove-confirm'); nodes.removeConfirm.hidden = true;
    nodes.removeConfirm.append(text('p', '', 'Stop webhook notifications for this Agent? Its identity, mailbox and fallback task are kept.'));
    const removeActions = el('div', 'wake-actions'); nodes.removeButton = button('Disconnect', 'secondary', () => void mutate('remove'));
    removeActions.append(nodes.removeButton, button('Cancel', 'secondary', () => { nodes.removeConfirm.hidden = true; nodes.disconnect.focus(); })); nodes.removeConfirm.append(removeActions);
    nodes.form = el('form', 'wake-form'); nodes.form.autocomplete = 'off';
    const url = formField('Webhook URL', 'url', 2048), token = formField('Sender key', 'token', 4096); nodes.url = url.input; nodes.token = token.input;
    const privacy = text('p', 'wake-secret-hint', 'Paste both values only here. Do not send them in a chat, connection prompt or shared document.'); privacy.id = 'wake-secret-hint';
    nodes.url.setAttribute('aria-describedby', privacy.id); nodes.token.setAttribute('aria-describedby', privacy.id);
    nodes.save = text('button', 'primary', 'Save private configuration'); nodes.save.type = 'submit';
    nodes.cancel = button('Cancel', 'secondary', () => { clearSecrets(); editing = false; errorKey = ''; render(); nodes.replace.focus(); });
    const formActions = el('div', 'wake-actions'); formActions.append(nodes.save, nodes.cancel); nodes.form.append(url.label, token.label, privacy, formActions);
    nodes.form.addEventListener('submit', event => { event.preventDefault(); if (nodes.form.reportValidity()) void mutate('save'); });
    credentials.append(nodes.saved, nodes.removeConfirm, nodes.form, text('p', 'fine wake-save-note', 'Saving does not start a model turn. Send the receiving test when you are ready.'));
    const verify = step(3, 'Verify actual processing');
    verify.append(text('p', 'wake-description', 'Send one test message asking the Agent to calculate 37 × 19 + 11. Verification requires its reply with 714 and an ACK of that same message.'));
    const observations = el('dl', 'wake-observations'); nodes.trigger = el('dd'); nodes.proof = el('dd');
    for (const [label, value] of [['Webhook trigger', nodes.trigger], ['Message processing', nodes.proof]]) { const row = el('div'); row.append(text('dt', '', label), value); observations.append(row); }
    nodes.timeline = el('div', 'wake-evidence'); nodes.test = button('Send receiving test', 'primary', () => void mutate('test'));
    nodes.retry = button('Retry wake', 'secondary', () => void mutate('retry'));
    nodes.open = button('Open test conversation', 'secondary', () => { const thread = data?.verification?.thread_id; if (thread) void openConversation({ ...agent, oldest_pending: { thread_id: thread } }); });
    const verifyActions = el('div', 'wake-actions'); verifyActions.append(nodes.test, nodes.retry, nodes.open);
    verify.append(observations, nodes.timeline, verifyActions, text('p', 'fine', 'A trigger accepted by Grok Bot is not a WebSocket connection or proof of processing. A fallback run can also complete this test.'));
    steps.append(routine, credentials, verify); root.append(back, header, intro, nodes.notice, nodes.error, nodes.feedback, steps);
    root.hidden = false; back.focus({ preventScroll: true }); render();
  }
  function render() {
    if (!agent) return;
    for (const [node, key] of translations) node.textContent = t(key);
    // Labels contain inputs, so translate their leading text without replacing children.
    for (const [input, key] of [[nodes.url, 'Webhook URL'], [nodes.token, 'Sender key']]) input.parentElement.firstChild.textContent = t(key);
    const supported = data?.supported !== false, enabled = !!agent.active, secure = privateWakeTransport(location.href);
    nodes.notice.hidden = !stale && supported && enabled && secure;
    nodes.notice.textContent = t(!secure ? 'Open this workspace over HTTPS before entering private credentials.' : !enabled ? 'This Agent is disabled. Enable it before configuring receiving.' : !supported ? 'This deployment cannot send durable webhook wakes. It needs the Cloudflare notification binding; the existing fallback task can still check the mailbox.' : 'Status could not be refreshed. Current trigger and processing state are unknown.');
    nodes.saved.hidden = !data?.configured || editing; nodes.operator.hidden = data?.source !== 'operator';
    nodes.form.hidden = !supported || !enabled || !secure || !!data?.configured && !editing;
    nodes.cancel.hidden = !data?.configured; nodes.form.setAttribute('aria-busy', String(busy));
    for (const input of [nodes.url, nodes.token]) input.disabled = busy || !supported || !enabled || !secure;
    nodes.refresh.disabled = busy;
    nodes.save.disabled = busy || !data || stale;
    nodes.save.textContent = t(busy ? 'Saving…' : 'Save private configuration');
    nodes.replace.disabled = busy || stale || !enabled || !secure;
    for (const control of [nodes.disconnect, nodes.removeButton]) control.disabled = busy || stale;
    nodes.error.hidden = !errorKey; nodes.error.textContent = t(errorKey);
    nodes.feedback.hidden = !feedbackKey; nodes.feedback.textContent = t(feedbackKey === 'Test message saved. Waiting for the Agent’s reply and ACK.' && data?.verification?.state === 'verified' ? 'Reply and ACK verified' : feedbackKey);
    nodes.trigger.textContent = t(stale ? 'Unknown' : data?.wake_webhook ? wakeStatusLabel(data.wake_webhook.state) : 'Not configured');
    const verification = data?.verification, state = verification?.state ?? 'not_started';
    nodes.proof.textContent = t(stale ? 'Unknown' : verificationLabel(state)); nodes.proof.className = !stale && state === 'verified' ? 'wake-verified' : '';
    nodes.timeline.replaceChildren();
    for (const [label, stamp] of [['Test message saved', verification?.created_at], ['Agent reply received', verification?.reply_at], ['Agent ACK received', verification?.acked_at], ['Last trigger accepted', data?.wake_webhook?.last_accepted_at], ['Next notification attempt', data?.wake_webhook?.next_attempt_at]]) {
      if (!stamp) continue;
      const row = el('p'), date = el('time', '', new Date(stamp).toLocaleString(locale())); date.dateTime = stamp; row.append(el('span', '', t(label)), date); nodes.timeline.append(row);
    }
    nodes.test.disabled = busy || !supported || !enabled || !data?.configured || stale;
    nodes.test.textContent = t(['waiting', 'replied', 'acked'].includes(state) ? 'Check existing test' : 'Send receiving test');
    const wake = data?.wake_webhook;
    nodes.retry.hidden = !data?.configured || !['failed', 'accepted', 'idle', 'ready'].includes(wake?.state);
    nodes.retry.disabled = busy || stale || !enabled;
    nodes.open.hidden = !verification?.thread_id; nodes.open.disabled = busy;
  }
  async function mutate(action) {
    if (!agent || busy || action === 'save' && !privateWakeTransport(location.href)) { clearSecrets(); return; }
    const current = generation, endpoint = path(); busy = true; errorKey = feedbackKey = ''; render();
    try {
      if (action === 'save') {
        const credentials = { provider: 'grokbot', url: nodes.url.value.trim(), token: nodes.token.value.trim() };
        // Release the DOM's copies before awaiting the request, even on failure.
        clearSecrets();
        const result = await api(endpoint + '/config', { method: 'PUT', data: credentials });
        if (current !== generation) return;
        mutationRevision++; data = result; editing = false; stale = false; testKey = null; feedbackKey = 'Private configuration saved. Send a test to verify receiving.';
      } else if (action === 'remove') {
        const result = await api(endpoint + '/config', { method: 'DELETE' });
        if (current !== generation) return;
        mutationRevision++; clearSecrets(); data = result; editing = false; nodes.removeConfirm.hidden = true; stale = false; testKey = null; feedbackKey = 'Webhook disconnected. Your mailbox and fallback task are unchanged.';
      } else if (action === 'test') {
        testKey ??= crypto.randomUUID();
        const result = await api(endpoint + '/test', { method: 'POST', data: {}, key: testKey });
        if (current !== generation) return;
        mutationRevision++; data = result; stale = false; testKey = null; feedbackKey = 'Test message saved. Waiting for the Agent’s reply and ACK.';
      } else {
        const result = await api(endpoint, { method: 'POST' });
        if (current !== generation) return;
        mutationRevision++; feedbackKey = result.queued ? 'Wake queued. Processing still requires the Agent’s reply and ACK.' : 'No pending messages';
      }
      await sync.refresh().catch(() => {});
    } catch (error) {
      if (current !== generation) return;
      clearSecrets();
      if ([401, 403].includes(error.status)) { close(); onUnauthorized(); return; }
      errorKey = action === 'save' ? 'Could not save the configuration. Check the native Grok Bot webhook URL and sender key, then enter both again.' : 'The request could not be completed. Refresh the status and try again.';
    } finally { if (current === generation) { busy = false; render(); } }
  }
  const sync = createChatSync({ baseDelay: 5000, random: () => 0,
    refresh: async current => { if (!agent) return; const target = generation, revision = mutationRevision; let result;
      try { result = await api(path() + '/config'); } catch (error) { if (error.status === 403 && target === generation) { close(); onUnauthorized(); return; } throw error; } if (current() && target === generation && revision === mutationRevision) { data = result; stale = false; if (!initialized) { editing = !data.configured; initialized = true; } } },
    onState: state => { if (['retrying', 'offline', 'paused'].includes(state.status)) stale = true; render(); },
    onUnauthorized: () => { close(); onUnauthorized(); }
  });
  return { open(p) { close(); agent = p; initialized = false; editing = false; stale = false; feedbackKey = errorKey = ''; build(); void sync.start().catch(() => {}); }, close, render,
    availabilityChanged: sync.availabilityChanged, clearSecrets, get isOpen() { return !!agent; } };
}
