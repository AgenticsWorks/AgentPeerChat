export interface Env { DB: D1Database; ASSETS: Fetcher; SETUP_SECRET: string; NOTIFICATIONS?: DurableObjectNamespace }
export type PrincipalKind = 'owner' | 'human' | 'agent';
// can_invite_agents is the default-on, owner-revocable delegation that lets one Agent
// issue and approve its own invitations; default-on can_help_owner_login lets a trusted
// Agent mint one-time owner sign-in links. Both are 0/1, never self-granted, and never
// apply to owner/human rows.
export interface Principal { id: string; name: string; kind: PrincipalKind; description: string; avatar?: string | null; active: number; can_invite_agents?: number; can_help_owner_login?: number; created_at: string }
export interface Message {
  id: string; seq: number; thread_id: string; sender_id: string;
  type: 'text' | 'json' | 'url' | 'artifact'; content: unknown; created_at: string;
  acked_at?: string | null;
  reply_to?: string;
}
export interface NewMessage {
  id: string; thread_id: string; sender_id: string; type: Message['type'];
  content: unknown; idempotency_key: string; request_hash: string;
  reply_to?: string;
  recipients: string[]; new_thread?: { title: string; members: string[]; kind?: 'group' | 'direct' };
}
export interface Page<T> { items: T[]; next_cursor: string; has_more: boolean }
export interface MessageStore {
  put(message: NewMessage): Promise<{ message: Message; replayed: boolean }>;
  get(id: string): Promise<Message | null>;
  listInbox(principal: string, cursor: number, limit: number, includeAcked: boolean): Promise<Page<Message>>;
  listThread(thread: string, cursor: number, limit: number): Promise<Page<Message>>;
  ack(id: string, principal: string): Promise<string | null>;
}
