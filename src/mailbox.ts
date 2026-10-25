import type { Env, Message } from './types';
import { fail, pagination } from './security';

// Owner observation is deliberately separate from /inbox: it never records an
// Agent check, acquires a receiver lease, or acknowledges a delivery.
export async function agentMailbox(env: Env, url: URL, agentId: string) {
  const agent = await env.DB.prepare("SELECT id, name, avatar, active FROM principals WHERE id = ? AND kind = 'agent'")
    .bind(agentId).first();
  if (!agent) fail(404, 'not_found', 'Agent not found.');
  const status = url.searchParams.get('status') ?? 'pending';
  if (!['pending', 'acked', 'all'].includes(status)) fail(400, 'invalid_field', 'status must be pending, acked, or all.');
  const before = url.searchParams.get('before') ?? String(Number.MAX_SAFE_INTEGER);
  if (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before))) fail(400, 'invalid_cursor', 'before must be a nonnegative safe integer cursor.');
  const { limit } = pagination(url);
  const query = (url.searchParams.get('q') ?? '').trim();
  if (query.length > 200) fail(400, 'invalid_field', 'q must be at most 200 characters.');
  const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
  const conditions = status === 'pending' ? 'AND d.acked_at IS NULL' : status === 'acked' ? 'AND d.acked_at IS NOT NULL' : '';
  type MailboxRow = Omit<Message, 'content'> & { content: string; sender_name: string; sender_avatar: string | null; thread_title: string; thread_kind: string };
  const { results } = await env.DB.prepare(`SELECT m.id, m.seq, m.thread_id, m.sender_id, m.type, m.content, m.created_at, m.reply_to,
      d.acked_at, p.name AS sender_name, p.avatar AS sender_avatar, t.title AS thread_title, t.kind AS thread_kind
    FROM deliveries d JOIN messages m ON m.seq = d.message_seq
    JOIN principals p ON p.id = m.sender_id JOIN threads t ON t.id = m.thread_id
    WHERE d.recipient_id = ? AND d.message_seq < ? ${conditions}
      AND (? = '' OR m.content LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\')
    ORDER BY d.message_seq DESC LIMIT ?`).bind(agentId, Number(before), query, pattern, pattern, pattern, limit + 1).all<MailboxRow>();
  const totals = await env.DB.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN acked_at IS NULL THEN 1 ELSE 0 END), 0) AS pending,
    COALESCE(SUM(CASE WHEN acked_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS acked
    FROM deliveries WHERE recipient_id = ?`).bind(agentId).first();
  const items: (Omit<MailboxRow, 'content'> & { content: unknown })[] = [];
  let bytes = 2;
  for (const row of results.slice(0, limit)) {
    const { reply_to, ...message } = row;
    const item = { ...message, ...(reply_to ? { reply_to } : {}), content: JSON.parse(row.content) as unknown };
    const size = new TextEncoder().encode(JSON.stringify(item)).byteLength + (items.length ? 1 : 0);
    if (items.length && bytes + size > 256 * 1024) break;
    items.push(item); bytes += size;
  }
  return { agent, totals, items, next_cursor: String(items.at(-1)?.seq ?? before), has_more: results.length > items.length };
}
