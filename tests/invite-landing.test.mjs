import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// The recipient landing page is public content: it explains the bounded join, never asks for
// the owner's key, and never claims or approves an invitation by itself.
test('the invitation landing explains the bounded join without asking for owner credentials', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const section = html.slice(html.indexOf('id="agent-invite"'), html.indexOf('id="invite-back"'));
  assert.ok(section.length > 200, 'a dedicated recipient section exists');
  for (const marker of ['invite-steps-list', 'invite-command', 'copy-invite-command', 'invite-error'])
    assert.ok(section.includes(marker), marker);
  assert.ok(!section.includes('type="password"'), 'the recipient path has no credential field');
  assert.ok(!section.includes('auth-key'), 'the owner sign-in form stays outside the recipient section');
  // Static, fetchable text for agents that only read the root HTML.
  assert.ok(html.includes('id="public-agent-note"'));
  assert.match(html, /#agent-invite=/);
  assert.ok((html.match(/href="\/agent-guide\.md"/g) ?? []).length >= 2, 'the root page links the agent guide');
});

test('the app resolves invitation links publicly, keeps the code out of history and never claims one', async () => {
  const app = await readFile('public/app.js', 'utf8');
  assert.match(app, /history\.replaceState\(null, '', location\.pathname \+ location\.search\)/);
  assert.match(app, /\/pairings\/resolve/);
  assert.match(app, /join --invite '/);
  assert.match(app, /--no-wait/);
  assert.match(app, /params\.has\('agent-invite'\)/);
  const view = app.slice(app.indexOf('async function showAgentInvitation'), app.indexOf("$('#invite-back')"));
  assert.ok(!view.includes('/session'), 'opening a link never signs anyone in');
  assert.ok(!/approve|reject/.test(view), 'opening a link never resolves an invitation');
  assert.match(view, /status === 410/, 'a used, expired or revoked link is explained instead of retried');
});

test('the owner delegation switch is part of the contact view and bilingual', async () => {
  const [app, locales] = await Promise.all([readFile('public/app.js', 'utf8'), readFile('public/locales.js', 'utf8')]);
  assert.match(app, /can_invite_agents/);
  assert.match(app, /t\("Allow Agent invitations"\)/);
  assert.ok(locales.includes('"Allow Agent invitations"'));
  assert.match(app, /inviter_name/, 'agent-issued approvals show who issued them');
});
