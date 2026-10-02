import type { Message, MessageStore, NewMessage, Page } from './types';

type Row = Omit<Message, 'content'> & { content: string; request_hash?: string };
const decode = (row: Row): Message => {
  const { request_hash: _hash, ...message } = row;
  return { ...message, content: JSON.parse(row.content) };
};
function page(rows: Row[], cursor: number, limit: number): Page<Message> {
  const items = rows.slice(0, limit).map(decode);
  return { items, next_cursor: String(items.at(-1)?.seq ?? cursor), has_more: rows.length > limit };
}

export class IdempotencyConflict extends Error {}

export class D1MessageStore implements MessageStore {
  constructor(private db: D1Database) {}

  async put(m: NewMessage): Promise<{ message: Message; replayed: boolean }> {
    const existing = await this.db.prepare('SELECT * FROM messages WHERE sender_id = ? AND idempotency_key = ?')
      .bind(m.sender_id, m.idempotency_key).first<Row>();
    if (existing) return this.replay(existing, m);
    const statements: D1PreparedStatement[] = [];
    if (m.new_thread) {
      statements.push(this.db.prepare(`INSERT ${m.new_thread.kind === 'direct' ? 'OR IGNORE ' : ''}INTO threads(id, title, created_by, kind) VALUES (?, ?, ?, ?)` )
        .bind(m.thread_id, m.new_thread.title, m.sender_id, m.new_thread.kind ?? 'group'));
      statements.push(this.db.prepare(`INSERT ${m.new_thread.kind === 'direct' ? 'OR IGNORE ' : ''}INTO thread_members(thread_id, principal_id) VALUES ${m.new_thread.members.map(() => '(?, ?)').join(',')}`)
        .bind(...m.new_thread.members.flatMap(member => [m.thread_id, member])));
    } else {
      statements.push(this.db.prepare('INSERT OR IGNORE INTO thread_members(thread_id, principal_id) VALUES (?, ?)')
        .bind(m.thread_id, m.sender_id));
    }
    statements.push(this.db.prepare(`INSERT INTO messages(id, thread_id, sender_id, type, content, idempotency_key, request_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(m.id, m.thread_id, m.sender_id, m.type, JSON.stringify(m.content), m.idempotency_key, m.request_hash));
    // Bulk inserts keep even a 32-member direct conversation well below Free's 50-query invocation limit.
    statements.push(this.db.prepare(`WITH recipients(recipient_id) AS (VALUES ${m.recipients.map(() => '(?)').join(',')})
      INSERT INTO deliveries(recipient_id, message_seq)
      SELECT r.recipient_id, m.seq FROM recipients r CROSS JOIN messages m WHERE m.id = ?`).bind(...m.recipients, m.id));
    statements.push(this.db.prepare('UPDATE threads SET message_count = message_count + 1, last_message_seq = (SELECT seq FROM messages WHERE id = ?) WHERE id = ?')
      .bind(m.id, m.thread_id));
    try { await this.db.batch(statements); }
    catch (error) {
      // A concurrent retry may have won. D1 rolls the entire batch back on failure.
      const raced = await this.db.prepare('SELECT * FROM messages WHERE sender_id = ? AND idempotency_key = ?')
        .bind(m.sender_id, m.idempotency_key).first<Row>();
      if (raced) return this.replay(raced, m);
      throw error;
    }
    return { message: (await this.get(m.id))!, replayed: false };
  }

  private replay(row: Row, m: NewMessage) {
    if (row.request_hash !== m.request_hash) throw new IdempotencyConflict();
    return { message: decode(row), replayed: true };
  }

  async get(id: string) {
    const row = await this.db.prepare('SELECT * FROM messages WHERE id = ?').bind(id).first<Row>();
    return row ? decode(row) : null;
  }

  async listInbox(principal: string, cursor: number, limit: number, includeAcked: boolean) {
    const { results } = await this.db.prepare(`SELECT m.*, d.acked_at FROM deliveries d
      JOIN messages m ON m.seq = d.message_seq
      WHERE d.recipient_id = ? AND d.message_seq > ? ${includeAcked ? '' : 'AND d.acked_at IS NULL'}
      ORDER BY d.message_seq ASC LIMIT ?`).bind(principal, cursor, limit + 1).all<Row>();
    return page(results, cursor, limit);
  }

  async listThread(thread: string, cursor: number, limit: number) {
    const { results } = await this.db.prepare('SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .bind(thread, cursor, limit + 1).all<Row>();
    return page(results, cursor, limit);
  }

  async ack(id: string, principal: string) {
    const row = await this.db.prepare(`UPDATE deliveries SET acked_at = COALESCE(acked_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE recipient_id = ? AND message_seq = (SELECT seq FROM messages WHERE id = ?) RETURNING acked_at`)
      .bind(principal, id).first<{ acked_at: string }>();
    return row?.acked_at ?? null;
  }
}
