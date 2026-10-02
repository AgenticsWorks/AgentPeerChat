import type { Env, Principal } from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message); }
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
export function secret(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${prefix}_${Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')}`;
}
export async function hash(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export async function equalsSecret(a: string, b: string) { return await hash(a) === await hash(b); }

export interface Identity { principal: Principal; tokenId: string; tokenKind: 'access' | 'session' }
export async function authenticate(request: Request, env: Env): Promise<Identity> {
  const auth = request.headers.get('Authorization');
  const cookie = request.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('ag_session='))?.slice(11);
  const token = auth ? (/^Bearer (\S+)$/.exec(auth)?.[1] ?? '') : cookie;
  if (!token) fail(401, 'unauthorized', 'Sign in or provide a Bearer access key.');
  const row = await env.DB.prepare(`SELECT p.*, t.id AS token_id, t.kind AS token_kind FROM tokens t
    JOIN principals p ON p.id = t.principal_id
    WHERE t.hash = ? AND t.revoked_at IS NULL AND p.active = 1
    AND (t.expires_at IS NULL OR t.expires_at > ?)
    AND (t.parent_id IS NULL OR EXISTS (SELECT 1 FROM tokens parent WHERE parent.id = t.parent_id
      AND parent.revoked_at IS NULL AND (parent.expires_at IS NULL OR parent.expires_at > ?)))`)
    .bind(await hash(token), new Date().toISOString(), new Date().toISOString())
    .first<Principal & { token_id: string; token_kind: Identity['tokenKind'] }>();
  if (!row) fail(401, 'unauthorized', 'Access key is invalid, expired, or revoked.');
  if (!auth && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) checkOrigin(request);
  const { token_id, token_kind, ...principal } = row;
  return { principal, tokenId: token_id, tokenKind: token_kind };
}
export function checkOrigin(request: Request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin) fail(403, 'origin_mismatch', 'This action requires a same-origin browser request.');
}
export function owner(p: Principal) { if (p.kind !== 'owner') fail(403, 'forbidden', 'Only the instance owner can do this.'); }
export function human(p: Principal) { if (p.kind === 'agent') fail(403, 'forbidden', 'A human identity is required.'); }

export async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) fail(415, 'content_type', 'Use Content-Type: application/json.');
  if (Number(request.headers.get('Content-Length') ?? 0) > 65536) fail(413, 'body_too_large', 'Maximum request size is 64 KiB.');
  // Read incrementally: untrusted clients may omit Content-Length.
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_json', 'A JSON object is required.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); fail(413, 'body_too_large', 'Maximum request size is 64 KiB.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'invalid_json', 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_json', 'A JSON object is required.');
  return value as Record<string, unknown>;
}
export function str(value: unknown, field: string, max = 120): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_field', `${field} must be a nonempty string of at most ${max} characters.`);
  return value.trim();
}
export function ids(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) fail(400, 'invalid_field', `${field} must contain 1–32 principal IDs.`);
  return [...new Set(value.map(v => str(v, field, 80)))].sort();
}
export function pagination(url: URL) {
  const after = url.searchParams.get('after') ?? '0', limit = url.searchParams.get('limit') ?? '50';
  if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) fail(400, 'invalid_cursor', 'after must be a nonnegative safe integer cursor.');
  if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) fail(400, 'invalid_limit', 'limit must be between 1 and 100.');
  return { after: Number(after), limit: Number(limit) };
}
export async function mintToken(env: Env, principal: string, label: string, kind: 'access' | 'session' = 'access', parent: string | null = null) {
  const token = secret(kind === 'session' ? 'ags' : 'agt');
  const tokenId = id('tok');
  const expires = kind === 'session' ? new Date(Date.now() + 7 * 86400000).toISOString() : null;
  await env.DB.prepare('INSERT INTO tokens(id, principal_id, hash, label, kind, parent_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(tokenId, principal, await hash(token), label, kind, parent, expires).run();
  return { id: tokenId, token, expires_at: expires };
}
export function sessionCookie(request: Request, token: string, clear = false) {
  return `ag_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear ? 0 : 7 * 86400}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
