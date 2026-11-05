import type { Env } from './types';
import { hash } from './security';

// Grok Bot Routines use Bearer authentication and HTTP 200 (not Grok.com's
// HMAC protocol). Browser registration has a narrower provider allowlist than
// the legacy operator-owned binding.
type Target = { provider: 'grokbot'; url: string; token: string };
interface PrivateConfig { principal_id: string; target: Target | null }
type State = 'ready' | 'queued' | 'sending' | 'retrying' | 'accepted' | 'idle' | 'failed' | 'invalid' | 'unsupported' | 'disabled' | 'unknown';
export interface WakeWebhookStatus {
  provider: 'grokbot'; state: State; attempts: number;
  last_attempt_at: string | null; last_accepted_at: string | null;
  next_attempt_at: string | null; last_http_status: number | null;
}
interface RecordState extends Omit<WakeWebhookStatus, 'next_attempt_at'> {
  principal_id: string; fingerprint: string; accepted_seq: number; target_seq: number;
  next_attempt_at: number | null; attempt_id: string | null;
}
type Storage = Pick<DurableObjectStorage, 'get' | 'put' | 'setAlarm' | 'deleteAlarm'>;
const key = 'wake-webhook';
const configKey = 'wake-webhook-private-config';
const maxAttempts = 5;
const delay = (attempt: number) => 30000 * 2 ** Math.max(0, attempt - 1);
const queued = (state: State) => ['queued', 'sending', 'retrying'].includes(state);
const empty = (state: State): WakeWebhookStatus => ({ provider: 'grokbot', state, attempts: 0,
  last_attempt_at: null, last_accepted_at: null, next_attempt_at: null, last_http_status: null });

// A saved URL can cause server-side requests. Accept only the native provider's
// exact endpoint, never arbitrary callbacks, IP addresses or redirect targets.
export function privateWebhookTarget(value: unknown): Target {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    const target = value as Record<string, unknown>;
    if (target.provider !== 'grokbot' || typeof target.url !== 'string' || target.url.length > 2048
      || typeof target.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(target.token)) throw Error();
    const url = new URL(target.url);
    if (url.protocol !== 'https:' || url.hostname !== 'api2.cursor.sh' || url.port || url.username || url.password
      || url.search || url.hash || !/^\/automations\/webhook\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname)
      || target.url !== url.href) throw Error();
    return { provider: 'grokbot', url: url.href, token: target.token };
  } catch { throw Error('Use the Grok Bot Routine POST URL and sender key from its desktop panel.'); }
}

export function webhookTarget(env: Env, principal: string): Target | null {
  if (!env.AGENTPEERCHAT_WAKE_WEBHOOKS) return null;
  try {
    const config = JSON.parse(env.AGENTPEERCHAT_WAKE_WEBHOOKS);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error();
    if (!Object.hasOwn(config, principal)) return null;
    const target = config[principal];
    if (!target || target.provider !== 'grokbot' || typeof target.url !== 'string' || target.url.length > 2048
      || typeof target.token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(target.token)) throw Error();
    const url = new URL(target.url), host = url.hostname.toLowerCase().replace(/\.$/, '');
    // Configuration is trusted operator input. Restrict obvious local targets as
    // defense in depth, and never follow redirects with the routine's credential.
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
      || !host.includes('.') || /[\[\]:]/.test(host) || /^[\d.]+$/.test(host)
      || /(^|\.)(localhost|local|internal|lan)$/.test(host)) throw Error();
    return { provider: 'grokbot', url: url.href, token: target.token };
  } catch { throw Error('Invalid wake webhook configuration.'); }
}

export function webhookAvailability(env: Env, principal: string, active = true): WakeWebhookStatus | null {
  try {
    if (!webhookTarget(env, principal)) return null;
    return empty(!active ? 'disabled' : env.NOTIFICATIONS ? 'unknown' : 'unsupported');
  } catch { return empty('invalid'); }
}

function publicStatus(record: RecordState): WakeWebhookStatus {
  return { provider: record.provider, state: record.state, attempts: record.attempts,
    last_attempt_at: record.last_attempt_at, last_accepted_at: record.last_accepted_at,
    next_attempt_at: record.next_attempt_at === null ? null : new Date(record.next_attempt_at).toISOString(),
    last_http_status: record.last_http_status };
}

// One durable, coalesced wake per recipient. Queue metadata contains no secrets.
// Owner-entered credentials live in a separate private DO record, encrypted at
// rest by Cloudflare, and are never returned by any application read endpoint.
export class WakeWebhook {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private storage: Storage, private env: Env,
    private fetcher: typeof fetch = (input, init) => fetch(input, init), private clock: () => number = Date.now) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work); this.serial = result.catch(() => {}); return result;
  }
  private async target(principal: string): Promise<Target | null> {
    const saved = await this.storage.get<PrivateConfig>(configKey);
    if (saved && saved.principal_id === principal) return saved.target === null ? null : privateWebhookTarget(saved.target);
    return webhookTarget(this.env, principal);
  }
  async configuration(principal: string) {
    const saved = await this.storage.get<PrivateConfig>(configKey);
    let configured = false;
    try { configured = !!await this.target(principal); } catch { /* Safe invalid status below. */ }
    return { supported: !!this.env.NOTIFICATIONS, configured,
      source: saved?.principal_id === principal ? saved.target ? 'private' as const : null : configured ? 'operator' as const : null,
      wake_webhook: await this.status(principal) };
  }
  async configure(principal: string, value: unknown | null): Promise<void> {
    const target = value === null ? null : privateWebhookTarget(value);
    await this.exclusive(async () => {
      // Null is a deliberate disconnect, not permission to restore env fallback.
      // Atomic multi-key write: a restart after saving cannot retain an old
      // queued attempt and unexpectedly execute the replacement credentials.
      await this.storage.put({ [configKey]: { principal_id: principal, target }, [key]: null });
      await this.storage.deleteAlarm();
    });
  }
  private async pending(principal: string) {
    return await this.env.DB.prepare(`SELECT p.active, MAX(d.message_seq) AS seq FROM principals p
      LEFT JOIN deliveries d ON d.recipient_id=p.id AND d.acked_at IS NULL
      WHERE p.id=? AND p.kind='agent' GROUP BY p.id`).bind(principal).first<{ active: number; seq: number | null }>();
  }
  async status(principal: string): Promise<WakeWebhookStatus | null> {
    let target: Target | null;
    try { target = await this.target(principal); } catch { return empty('invalid'); }
    if (!target) return null;
    if (!this.env.NOTIFICATIONS) return empty('unsupported');
    const record = await this.storage.get<RecordState>(key);
    if (!record || record.principal_id !== principal || record.fingerprint !== await hash(JSON.stringify(target))) return empty('ready');
    return publicStatus(record);
  }
  async enqueue(principal: string, force = false): Promise<boolean> {
    return this.exclusive(async () => {
      const target = await this.target(principal);
      if (!target) return false;
      const pending = await this.pending(principal);
      if (!pending?.active || pending.seq === null) return false;
      const fingerprint = await hash(JSON.stringify(target));
      let record = await this.storage.get<RecordState>(key);
      if (!record || record.fingerprint !== fingerprint || record.principal_id !== principal) {
        record = { ...empty('ready'), principal_id: principal, fingerprint, accepted_seq: 0,
          target_seq: 0, next_attempt_at: null, attempt_id: null };
      }
      if (queued(record.state)) {
        // A newer notification must not reset backoff or the in-flight attempt.
        record.target_seq = Math.max(record.target_seq, pending.seq);
      } else {
        if (!force && (pending.seq <= record.accepted_seq || record.state === 'failed' && pending.seq <= record.target_seq)) return false;
        record.target_seq = pending.seq; record.attempts = 0; record.attempt_id = null;
        record.state = 'queued'; record.next_attempt_at = this.clock() + 1000;
      }
      await this.storage.put(key, record);
      await this.storage.setAlarm(record.next_attempt_at!);
      return true;
    });
  }
  async alarm(): Promise<void> {
    const attempt = await this.exclusive(async () => {
      const record = await this.storage.get<RecordState>(key);
      if (!record || !queued(record.state)) return null;
      let target: Target | null;
      try { target = await this.target(record.principal_id); }
      catch { record.state = 'invalid'; await this.finish(record); return null; }
      if (!target) { record.state = 'disabled'; await this.finish(record); return null; }
      const fingerprint = await hash(JSON.stringify(target));
      if (record.fingerprint !== fingerprint) { record.fingerprint = fingerprint; record.attempts = 0; record.accepted_seq = 0; }
      const pending = await this.pending(record.principal_id);
      if (!pending?.active || pending.seq === null) {
        record.state = pending?.active ? 'idle' : 'disabled'; await this.finish(record); return null;
      }
      if (record.next_attempt_at !== null && record.next_attempt_at > this.clock()) {
        await this.storage.setAlarm(record.next_attempt_at); return null;
      }
      if (record.attempts >= maxAttempts) { record.state = 'failed'; await this.finish(record); return null; }
      record.target_seq = Math.max(record.target_seq, pending.seq);
      record.attempts++; record.state = 'sending'; record.attempt_id = crypto.randomUUID();
      record.last_attempt_at = new Date(this.clock()).toISOString(); record.last_http_status = null;
      // Arm recovery before making the external call. Worker restarts cannot lose
      // a pending attempt; an uncertain request may be repeated, never auto-ACKed.
      record.next_attempt_at = this.clock() + delay(record.attempts);
      await this.storage.put(key, record); await this.storage.setAlarm(record.next_attempt_at);
      return { record: { ...record }, target };
    });
    if (!attempt) return;
    let status: number | null = null, retryAt = 0;
    try {
      const response = await this.fetcher(attempt.target.url, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + attempt.target.token },
        body: JSON.stringify({ type: 'agentpeerchat.mailbox_changed', principal_id: attempt.record.principal_id,
          event_id: 'wake_' + attempt.record.principal_id + '_' + attempt.record.target_seq })
      });
      status = response.status;
      const after = response.headers.get('Retry-After');
      if (after && [429, 503].includes(status)) {
        const value = /^\d+$/.test(after) ? this.clock() + Number(after) * 1000 : Date.parse(after);
        if (Number.isFinite(value) && value <= 8640000000000000) retryAt = value;
      }
      await response.body?.cancel();
    } catch { /* Exception/response text can contain secrets. Retain only status. */ }
    await this.exclusive(async () => {
      const record = await this.storage.get<RecordState>(key);
      if (!record || record.attempt_id !== attempt.record.attempt_id) return;
      record.last_http_status = status; record.attempt_id = null;
      if (status === 200) {
        record.accepted_seq = Math.max(record.accepted_seq, attempt.record.target_seq);
        record.last_accepted_at = new Date(this.clock()).toISOString();
        if (record.target_seq > attempt.record.target_seq) {
          record.state = 'queued'; record.attempts = 0; record.next_attempt_at = this.clock() + 1000;
        } else { record.state = 'accepted'; await this.finish(record); return; }
      } else if (record.attempts >= maxAttempts || status !== null && ![408, 429].includes(status) && status < 500) {
        record.state = 'failed'; await this.finish(record); return;
      } else {
        record.state = 'retrying'; record.next_attempt_at = Math.max(this.clock() + delay(record.attempts), retryAt);
      }
      await this.storage.put(key, record); await this.storage.setAlarm(record.next_attempt_at!);
    });
  }
  private async finish(record: RecordState) {
    record.next_attempt_at = null; record.attempt_id = null;
    await this.storage.put(key, record); await this.storage.deleteAlarm();
  }
}

// Used on idempotent send replay to recover a missed enqueue without emitting a
// second WebSocket notification or restarting an already accepted webhook batch.
export async function enqueueWakeWebhooks(env: Env, principals: string[]) {
  if (!env.NOTIFICATIONS) return;
  await Promise.all([...new Set(principals)].map(async principal => {
    try {
      const response = await env.NOTIFICATIONS!.getByName(principal).fetch('https://notifications/wake', { method: 'POST', headers: { 'X-Agent': principal } });
      if (!response.ok) throw Error('Wake enqueue unavailable');
    }
    catch { console.warn(JSON.stringify({ code: 'wake_webhook_deferred' })); }
  }));
}
