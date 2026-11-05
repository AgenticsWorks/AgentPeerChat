import type { Env, Principal } from './types';
import { hash, id } from './security';
import { D1MessageStore } from './store';

type Storage = Pick<DurableObjectStorage, 'get' | 'put'>;
interface TestRecord {
  agent: string; owner: string; message_id: string; thread_id: string;
  created_at: string; key: string;
}
interface TestState { generation: string; current: TestRecord | null }
export interface WakeVerificationStatus {
  state: 'waiting' | 'replied' | 'acked' | 'verified';
  message_id: string; thread_id: string; created_at: string;
  reply_at: string | null; acked_at: string | null;
}
const storageKey = 'wake-verification';
const content = '[AgentPeerChat receiving test] Calculate 37 × 19 + 11. Reply to this message with exactly 714, then ACK this message after successfully replying. Do not send another acknowledgment-only reply or change any configuration.';

// Test metadata is private to the recipient's coordinator. Evidence comes from
// normal D1 messages and delivery receipts, never a provider's HTTP response.
export class WakeVerification {
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private storage: Storage, private env: Env) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work); this.serial = result.catch(() => {}); return result;
  }
  async reset() {
    await this.exclusive(() => this.storage.put(storageKey, { generation: id('wvg'), current: null }));
  }
  async status(agent: string): Promise<WakeVerificationStatus | null> {
    const current = (await this.storage.get<TestState>(storageKey))?.current;
    return current?.agent === agent ? this.evidence(current) : null;
  }
  private async evidence(record: TestRecord): Promise<WakeVerificationStatus> {
    const row = await this.env.DB.prepare(`SELECT d.acked_at,
      (SELECT MIN(r.created_at) FROM messages r WHERE r.reply_to=m.id
        AND r.thread_id=m.thread_id AND r.sender_id=? AND r.seq>m.seq
        AND r.type='text' AND json_valid(r.content)
        AND trim(json_extract(r.content,'$'))='714') AS reply_at
      FROM messages m JOIN deliveries d ON d.message_seq=m.seq AND d.recipient_id=?
      WHERE m.id=? AND m.sender_id=?`).bind(record.agent, record.agent, record.message_id, record.owner)
      .first<{ acked_at: string | null; reply_at: string | null }>();
    const reply_at = row?.reply_at ?? null, acked_at = row?.acked_at ?? null;
    return { state: reply_at && acked_at ? 'verified' : reply_at ? 'replied' : acked_at ? 'acked' : 'waiting',
      message_id: record.message_id, thread_id: record.thread_id, created_at: record.created_at, reply_at, acked_at };
  }
  async start(agent: Principal, owner: string, requestKey: string): Promise<WakeVerificationStatus> {
    return this.exclusive(async () => {
      let state = await this.storage.get<TestState>(storageKey);
      if (!state) state = { generation: id('wvg'), current: null };
      // A retry, double click or another browser reuses the unfinished test.
      // Rotating configuration resets the generation so older receipts cannot
      // verify the replacement credentials.
      const existing = state.current;
      if (existing && (existing.agent !== agent.id || existing.owner !== owner)) throw Error('Verification identity mismatch.');
      const currentStatus = existing ? await this.evidence(existing) : null;
      const key = 'wake-test:' + await hash(state.generation + ':' + agent.id + ':' + owner + ':' + requestKey);
      if (!existing || currentStatus?.state === 'verified' && existing.key !== key) {
        const thread = 'thr_dm_' + (await hash([owner, agent.id].sort().join(':'))).slice(0, 40);
        // A late retry of an earlier request must never insert another test or
        // replace the currently displayed verification with stale evidence.
        const previous = await this.env.DB.prepare('SELECT id FROM messages WHERE sender_id=? AND idempotency_key=?')
          .bind(owner, key).first();
        if (previous && currentStatus) return currentStatus;
        state.current = { agent: agent.id, owner, key, message_id: id('msg'), thread_id: thread, created_at: new Date().toISOString() };
        // Persist first. If D1 fails or the object restarts, the next request
        // retries the same idempotent insert instead of losing the test.
        await this.storage.put(storageKey, state);
      }
      const record = state.current!;
      await new D1MessageStore(this.env.DB).put({ id: record.message_id, thread_id: record.thread_id,
        sender_id: owner, type: 'text', content, idempotency_key: record.key,
        request_hash: await hash(JSON.stringify({ agent: agent.id, content })), recipients: [agent.id],
        new_thread: { title: agent.name, members: [owner, agent.id], kind: 'direct' } });
      return this.evidence(record);
    });
  }
}
