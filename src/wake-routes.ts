import type { Env, Principal } from './types';
import { body, fail, owner } from './security';
import { privateWebhookTarget } from './wake-webhook';

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const unsupported = { supported: false, configured: false, source: null, wake_webhook: null, verification: null };

export async function wakeRoutes(request: Request, env: Env, path: string, p: Principal): Promise<Response | null> {
  const self = path === '/receiver/wake';
  const match = /^\/agents\/([^/]+)\/wake(?:\/(config|test))?$/.exec(path);
  if (!self && !match) return null;
  const method = request.method, action = self ? 'config' : match![2] ?? 'retry';
  if (self) {
    if (p.kind !== 'agent') fail(403, 'agent_required', 'Use an Agent identity.');
    if (method !== 'GET') fail(405, 'method_not_allowed', 'Agent webhook status is read-only.');
  } else owner(p);
  if (!(action === 'config' ? ['GET', 'PUT', 'DELETE'].includes(method) : method === 'POST'))
    fail(405, 'method_not_allowed', 'Unsupported webhook operation.');
  const agent = self ? p : await env.DB.prepare("SELECT * FROM principals WHERE id=? AND kind='agent'").bind(match![1]).first<Principal>();
  if (!agent) fail(404, 'not_found', 'Agent not found.');
  if (!agent.active && !['GET', 'DELETE'].includes(method)) fail(400, 'invalid_agent', 'Choose an enabled Agent.');
  const setup = self ? { setup_url: new URL('/#wake-agent=' + encodeURIComponent(agent.id), request.url).href } : {};
  if (!env.NOTIFICATIONS) {
    if (method === 'GET') return json({ ...unsupported, ...setup });
    fail(501, 'wake_unavailable', 'Webhook wakes require the Cloudflare notification binding.');
  }
  let input: unknown;
  if (method === 'PUT') {
    const url = new URL(request.url);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      fail(400, 'https_required', 'Use HTTPS to save private webhook credentials.');
    const value = await body(request);
    try { input = privateWebhookTarget(value); }
    catch { fail(400, 'invalid_webhook', 'Use the Grok Bot Routine POST URL and sender key from its desktop panel.'); }
  }
  const headers: Record<string, string> = { 'X-Agent': agent.id };
  if (action === 'test') {
    const key = request.headers.get('Idempotency-Key');
    if (!key || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) fail(400, 'idempotency_key_required', 'Provide a stable Idempotency-Key for this receiving test.');
    headers['X-Owner'] = p.id; headers['Idempotency-Key'] = key;
  }
  if (input !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await env.NOTIFICATIONS.getByName(agent.id).fetch('https://notifications/wake/' + action,
      { method, headers, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  } catch { fail(503, 'wake_unavailable', 'Webhook settings are temporarily unavailable. Try again.'); }
  if (!response.ok) {
    // Internal error text could include a credential; only relay known safe codes.
    if (response.status === 409) fail(409, 'wake_unconfigured', 'Save a valid webhook configuration before waking this Agent.');
    if (response.status === 400) fail(400, 'invalid_agent', 'Choose an enabled Agent.');
    fail(503, 'wake_unavailable', 'Webhook settings are temporarily unavailable. Try again.');
  }
  const result = await response.json<Record<string, unknown>>();
  if (!agent.active && result.wake_webhook) result.wake_webhook = { ...(result.wake_webhook as object), state: 'disabled' };
  return json({ ...result, ...setup }, action === 'test' || action === 'retry' ? 202 : 200);
}
