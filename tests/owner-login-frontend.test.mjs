import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Frontend regression checks for delegated owner sign-in help: the login page explains
// honest recovery, the Contact switch is a deliberate high-privilege grant, one-time links
// are cleared from history before any request, and deep links survive manual sign-in.
test('the login page offers honest forgotten-key help without credential fields', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const section = html.slice(html.indexOf('id="key-help"'), html.indexOf('id="agent-invite"'));
  assert.ok(section.includes('Forgot your access key?'));
  assert.ok(section.includes('id="key-help-body"'));
  assert.ok(!section.includes('type="password"'), 'recovery help asks for no secret input');
  assert.ok(!section.includes('value="agt_'), 'no key material is prefilled');
});

test('the app renders bilingual recovery guidance and never overstates the ability', async () => {
  const [app, locales] = await Promise.all([readFile('public/app.js', 'utf8'), readFile('public/locales.js', 'utf8')]);
  assert.match(app, /function renderKeyHelp\(\)/);
  assert.match(app, /t\("Ask a trusted connected Agent for a one-time sign-in link\./);
  assert.match(app, /agentpeerchat web --login/);
  assert.match(app, /Your old key cannot be read back/);
  assert.match(app, /cannot be recovered automatically/);
  assert.match(app, /\$\('#key-help'\)\.hidden = mode !== 'login'/, 'help is shown on the login mode only');
  for (const key of ['"允许协助我登录"', '"忘记访问密钥？"', '"我忘记了 AgentPeerChat 的访问密钥。请运行 agentpeerchat web --login，并把一次性登录链接发给我。"'])
    assert.ok(locales.includes(key), key);
});

test('the owner grant switch confirms before enabling and warns about account access', async () => {
  const app = await readFile('public/app.js', 'utf8');
  const view = app.slice(app.indexOf('function renderPrincipals'), app.indexOf('async function loadAccess'));
  assert.match(view, /can_help_owner_login/);
  assert.match(view, /t\("Allow helping me sign in"\)/);
  assert.match(view, /grants access to your owner account/);
  assert.match(view, /if \(next && !confirm\(/, 'enabling requires an explicit confirmation');
  assert.match(view, /loginToggle\.checked = false; return;/, 'cancelling the confirm leaves the switch off');
  assert.ok(!view.includes('can_help_owner_login: true`'), 'the UI never string-builds the permission payload');
});

test('a one-time link is cleared from history before redemption and never travels in a URL', async () => {
  const app = await readFile('public/app.js', 'utf8');
  const bootFn = app.slice(app.indexOf('async function boot'), app.indexOf('async function redeemOwnerLogin'));
  const clearAt = bootFn.indexOf('history.replaceState');
  const dispatchAt = bootFn.indexOf('await redeemOwnerLogin');
  assert.ok(clearAt !== -1 && dispatchAt !== -1 && clearAt < dispatchAt, 'the fragment is removed before any request');
  const redeem = app.slice(app.indexOf('async function redeemOwnerLogin'), app.indexOf('window.addEventListener(\'hashchange\''));
  const fetchAt = redeem.indexOf("api('/owner-login/redeem'");
  assert.ok(fetchAt !== -1);
  assert.match(redeem, /method: 'POST', data: \{ code \}/, 'the code is sent only in a same-origin POST body');
  assert.match(redeem, /state\.me[\s\S]{0,120}confirm\(/, 'an already signed-in owner confirms before a fresh session');
  assert.match(redeem, /error\.status === 410/, 'an expired, withdrawn or used link gets a clear explanation');
  assert.match(redeem, /state\.pendingThread = target/, 'a failed redemption still preserves the deep-link target for manual sign-in');
});

test('deep thread links are held through manual login and navigate directly when signed in', async () => {
  const app = await readFile('public/app.js', 'utf8');
  assert.match(app, /parameters\.get\('thread'\)/);
  assert.match(app, /state\.pendingThread = threadTarget/, 'a plain thread link stores its target before authentication');
  assert.match(app, /async function consumePendingThread\(\)/);
  assert.match(app, /await consumePendingThread\(\);\n\}/, 'entering a session consumes the pending target');
  const hashHandler = app.slice(app.indexOf("window.addEventListener('hashchange'"));
  assert.match(hashHandler, /params\.has\('owner-login'\)/, 'hash changes re-run boot for one-time links');
  assert.match(hashHandler, /params\.get\('thread'\)/, 'hash changes navigate a signed-in user to the thread');
  assert.match(hashHandler, /state\.me/, 'thread navigation waits for an existing session');
});
