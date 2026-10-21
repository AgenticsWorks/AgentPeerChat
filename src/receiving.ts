import type { Env } from './types';

// Observability must never prevent an Agent from receiving durable messages.
// Coalesce writes across isolates; timestamps can lag a successful check by 30s.
export async function recordInboxCheck(env: Env, principal: string) {
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(`INSERT INTO agent_receiving_activity(principal_id, last_checked_at) VALUES (?, ?)
      ON CONFLICT(principal_id) DO UPDATE SET last_checked_at = excluded.last_checked_at
      WHERE agent_receiving_activity.last_checked_at < ?`)
      .bind(principal, now, new Date(Date.now() - 30000).toISOString()).run();
  } catch { console.warn(JSON.stringify({ code: 'receiving_activity_unavailable' })); }
}

export interface NotificationStatus {
  state: 'connected' | 'connecting' | 'stale' | 'disconnected' | 'unknown' | 'unsupported' | 'disabled';
  connections: number | null;
  last_heartbeat_at: string | null;
}
const emptyStatus = (state: NotificationStatus['state']): NotificationStatus => ({ state, connections: null, last_heartbeat_at: null });

export function notificationSnapshot(connections: { heartbeat: number | null; connected: number }[], now = Date.now()): NotificationStatus {
  const heartbeats = connections.flatMap(o => o.heartbeat === null ? [] : [o.heartbeat]);
  const latest = heartbeats.length ? Math.max(...heartbeats) : null;
  const state = !connections.length ? 'disconnected' : latest !== null && now - latest < 120000 ? 'connected'
    : connections.some(o => o.heartbeat === null && now - o.connected < 120000) ? 'connecting' : 'stale';
  return { state, connections: connections.length, last_heartbeat_at: latest === null ? null : new Date(latest).toISOString() };
}

export async function receivingStatus(env: Env) {
  const { results } = await env.DB.prepare(`SELECT p.id, p.name, p.active, a.last_checked_at,
    (SELECT COUNT(*) FROM deliveries d WHERE d.recipient_id=p.id AND d.acked_at IS NULL) AS pending_count,
    (SELECT MAX(d.acked_at) FROM deliveries d WHERE d.recipient_id=p.id) AS last_ack_at,
    (SELECT m.created_at FROM messages m WHERE m.sender_id=p.id ORDER BY m.seq DESC LIMIT 1) AS last_sent_at,
    (SELECT d.message_seq FROM deliveries d WHERE d.recipient_id=p.id AND d.acked_at IS NULL ORDER BY d.message_seq LIMIT 1) AS oldest_pending_seq
    FROM principals p LEFT JOIN agent_receiving_activity a ON a.principal_id=p.id
    WHERE p.kind='agent' ORDER BY p.active DESC, p.created_at, p.id LIMIT 200`).all<{
      id: string; name: string; active: number; last_checked_at: string | null;
      pending_count: number; last_ack_at: string | null; last_sent_at: string | null; oldest_pending_seq: number | null;
    }>();
  const pending = (await env.DB.prepare(`SELECT m.seq, m.id, m.thread_id, m.created_at FROM messages m
    WHERE m.seq IN (SELECT MIN(d.message_seq) FROM deliveries d JOIN principals p ON p.id=d.recipient_id
      WHERE p.kind='agent' AND d.acked_at IS NULL GROUP BY d.recipient_id)`)
    .all<{ seq: number; id: string; thread_id: string; created_at: string }>()).results;
  const items = results.map(({ oldest_pending_seq, ...p }) => ({ ...p,
    oldest_pending: pending.find(m => m.seq === oldest_pending_seq) ?? null,
    notification: emptyStatus(!p.active ? 'disabled' : env.NOTIFICATIONS ? 'unknown' : 'unsupported'),
    receiving_mode: null, fallback_interval_seconds: null
  }));
  // Bounded fanout and a page-wide deadline. One unavailable object must not hide
  // the other Agents or turn an unavailable observation into an "offline" claim.
  let next = 0;
  const deadline = Date.now() + 4000;
  await Promise.all(Array.from({ length: Math.min(items.length, 8) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      if (!item.active || !env.NOTIFICATIONS || Date.now() >= deadline) continue;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const observation = (async () => {
          const response = await env.NOTIFICATIONS!.getByName(item.id).fetch('https://notifications/status');
          if (!response.ok) throw new Error('Observation unavailable');
          return await response.json<NotificationStatus>();
        })();
        item.notification = await Promise.race([observation, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Observation timed out')), Math.min(1500, Math.max(1, deadline - Date.now())));
        })]);
      } catch { item.notification = emptyStatus('unknown'); }
      finally { if (timeout !== undefined) clearTimeout(timeout); }
    }
  }));
  return { items, observed_at: new Date().toISOString(), check_resolution_seconds: 30 };
}
