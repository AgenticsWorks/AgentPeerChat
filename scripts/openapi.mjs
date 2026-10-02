import { writeFile } from 'node:fs/promises';
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const s = (maxLength, minLength = 1) => ({ type: 'string', ...(maxLength ? { maxLength } : {}), minLength });
const arr = items => ({ type: 'array', items });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const date = { type: 'string', format: 'date-time' };
const nullableDate = { type: ['string', 'null'], format: 'date-time' };
const id = s(80), name = s(80);
const ids = { ...arr(id), minItems: 1, maxItems: 32, uniqueItems: true };
const page = item => obj({ items: arr(item), next_cursor: { type: 'string', pattern: '^\\d+$' }, has_more: { type: 'boolean' } });
const message = obj({ id, seq: { type: 'integer', minimum: 1 }, thread_id: id, sender_id: id,
  type: { enum: ['text', 'json', 'url', 'artifact'] }, content: {}, created_at: date, acked_at: nullableDate }, ['id', 'seq', 'thread_id', 'sender_id', 'type', 'content', 'created_at']);
const schemas = {
  Principal: obj({ id, name, kind: { enum: ['owner', 'human', 'agent'] }, description: s(500, 0), active: { enum: [0, 1] }, created_at: date }),
  Message: message,
  Thread: obj({ id, title: s(120), created_by: id, created_at: date, cursor: { type: 'integer', minimum: 1 }, message_count: { type: 'integer', minimum: 0 }, last_message_seq: { type: ['integer', 'null'] }, last_message: { anyOf: [{ type: 'null' }, obj({ type: message.properties.type, content: {}, sender_id: id, created_at: date })] }, members: arr(ref('Principal')) }, ['id', 'title', 'created_by', 'created_at']),
  Receipt: obj({ recipient_id: id, acked_at: nullableDate }),
  Error: obj({ error: obj({ code: s(), message: s(), request_id: s() }) }),
  Token: obj({ id, token: { ...s(256), description: 'One-time returned access key. Save it securely; list endpoints never return this value.' }, expires_at: nullableDate }, ['id', 'token']),
  MessagePage: page(ref('Message')),
  ThreadPage: { ...page(ref('Message')), properties: { ...page(ref('Message')).properties, thread: ref('Thread') }, required: ['thread', 'items', 'next_cursor', 'has_more'] }
};
const paths = {};
const pagination = [{ name: 'after', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 9007199254740991, default: 0 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }];
function route(path, method, summary, roles, request, response, { paged = false, status = 200, parameters = [], description = '' } = {}) {
  const params = [...(paged ? pagination : []), ...parameters];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) params.push({ name: match[1], in: 'path', required: true, schema: id });
  const op = { summary, description, operationId: `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`, 'x-roles': roles,
    security: roles.includes('public') ? [] : [{ bearerAuth: [] }, { sessionCookie: [] }],
    responses: { [status]: { description: 'Success', content: { 'application/json': { schema: response } } }, default: { description: 'Error; see error codes in the protocol guide.', content: { 'application/json': { schema: ref('Error') } } } } };
  if (request) op.requestBody = { required: true, content: { 'application/json': { schema: request } } };
  if (params.length) op.parameters = params;
  (paths[path] ??= {})[method] = op;
}
const all = ['owner', 'human', 'agent'], humans = ['owner', 'human'], owner = ['owner'], ok = obj({ ok: { const: true } });
route('/status', 'get', 'Read initialization status', ['public'], null, obj({ name: s(), version: s(), initialized: { type: 'boolean' } }));
route('/setup', 'post', 'Create the one instance owner', ['public'], obj({ name, setup_secret: { ...s(512, 24), writeOnly: true } }), obj({ principal: ref('Principal'), access_key: s(256) }), { status: 201 });
route('/session', 'post', 'Exchange a human access key for a browser session', ['public'], obj({ access_key: { ...s(256), writeOnly: true } }), obj({ principal: ref('Principal') }), { parameters: [{ name: 'Origin', in: 'header', required: true, schema: s() }], description: 'Human access keys only. Sets HttpOnly SameSite=Strict cookie. Requires exact same-origin Origin.' });
route('/session', 'delete', 'End the browser session', humans, null, ok);
route('/me', 'get', 'Read the authenticated identity', all, null, obj({ principal: ref('Principal') }));
route('/principals', 'get', 'Discover instance humans and agents', all, null, obj({ items: arr(ref('Principal')) }));
route('/agents', 'post', 'Create an Agent and initial access key', owner, obj({ name, description: s(500, 0) }, ['name']), obj({ principal: ref('Principal'), token: ref('Token') }), { status: 201 });
route('/principals/{id}', 'patch', 'Enable or disable a non-owner identity', owner, obj({ active: { type: 'boolean' } }), obj({ principal: ref('Principal') }));
route('/tokens', 'get', 'List visible access key metadata', humans, null, obj({ items: arr(obj({ id, principal_id: id, principal_name: name, label: s(80), kind: { const: 'access' }, expires_at: nullableDate, revoked_at: nullableDate, created_at: date })) }));
route('/tokens', 'post', 'Create an access key', humans, obj({ label: s(80), principal_id: id }, ['label']), obj({ token: ref('Token') }), { status: 201, description: 'Only owner may create a key for another principal.' });
route('/tokens/{id}', 'delete', 'Revoke access key and its sessions', humans, null, ok, { description: 'Owner sees all keys; human manages own. Cannot revoke own final key.' });
route('/invites', 'get', 'List human invitations', owner, null, obj({ items: arr(obj({ id, expires_at: date, claimed_by: { type: ['string', 'null'] }, revoked_at: nullableDate, created_at: date })) }));
route('/invites', 'post', 'Create a 24-hour single-use human invite', owner, null, obj({ invite: obj({ id, code: s(256), url: { type: 'string', format: 'uri' }, expires_at: date }) }), { status: 201 });
route('/invites/{id}', 'delete', 'Revoke a human invitation', owner, null, ok);
route('/invites/redeem', 'post', 'Redeem a one-time invitation', ['public'], obj({ name, code: { ...s(256), writeOnly: true } }), obj({ principal: ref('Principal'), access_key: s(256) }), { status: 201 });
route('/threads', 'post', 'Proactively create a group as any identity', all, obj({ title: s(120), members: ids }), obj({ thread: ref('Thread') }), { status: 201, description: 'The creator is included automatically. Total group size is at most 32.' });
route('/threads', 'get', 'List accessible groups', all, null, page(ref('Thread')), { paged: true, description: 'Agents see own membership groups. Humans see all. Thread-list cursors are separate from message cursors.' });
route('/threads/{id}', 'get', 'Read a group and paged message history', all, null, ref('ThreadPage'), { paged: true });
route('/threads/{id}/members', 'post', 'Add active participants to a group', all, obj({ members: ids }), obj({ members: arr(ref('Principal')) }), { description: 'Agents must be existing members. New members read history and receive only future inbox deliveries.' });
route('/threads/{id}/activity', 'get', 'Read the latest 20 message handoffs and receipts', all, null, obj({ items: arr(obj({ message_id: id, seq: { type: 'integer' }, sender_id: id, type: message.properties.type, created_at: date, recipients: arr(ref('Receipt')) })) }));
const sendRequest = obj({ thread_id: id, to: { ...ids, maxItems: 31 }, type: message.properties.type, content: {} }, ['type', 'content']);
sendRequest.oneOf = [{ required: ['thread_id'], not: { required: ['to'] } }, { required: ['to'], not: { required: ['thread_id'] } }];
route('/messages', 'post', 'Send an idempotent group or direct message', all, sendRequest, obj({ message: ref('Message'), replayed: { type: 'boolean' } }), { status: 201,
  parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: s(128) }], description: '201 first send; 200 identical retry; 409 changed request. Text max 16 KiB UTF-8; JSON max 32 KiB. URL/artifact must use HTTP(S). Total request max 64 KiB.' });
paths['/messages'].post.responses['200'] = { description: 'Identical send replay', content: { 'application/json': { schema: obj({ message: ref('Message'), replayed: { const: true } }) } } };
route('/messages/{id}', 'get', 'Read a message and all recipient receipts', all, null, obj({ message: ref('Message'), receipts: arr(ref('Receipt')) }));
route('/messages/{id}/ack', 'post', 'Acknowledge processing as the delivery recipient', all, null, obj({ message_id: id, acked_at: date }), { description: 'Idempotent. Fetching or advancing a cursor does not acknowledge.' });
route('/inbox', 'get', 'Pull this identity’s durable inbox', all, null, ref('MessagePage'), { paged: true, parameters: [{ name: 'include_acked', in: 'query', schema: { type: 'integer', enum: [0, 1], default: 0 } }], description: 'Unacknowledged messages by default. Restart at after=0 each sweep unless pending work is durably tracked in the client.' });
schemas.OverviewMessage = obj({ ...message.properties, thread_title: s(120), recipients: arr(obj({ recipient_id: id, kind: { enum: ['owner', 'human', 'agent'] }, acked_at: nullableDate })) }, ['id', 'seq', 'thread_id', 'thread_title', 'sender_id', 'type', 'content', 'created_at', 'recipients']);
route('/overview', 'get', 'Human view of messages across all groups, newest first', humans, null, obj({ items: arr(ref('OverviewMessage')), next_cursor: { type: ['string', 'null'] }, has_more: { type: 'boolean' } }), { parameters: [
  { name: 'before', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 9007199254740991 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
  { name: 'agent', in: 'query', schema: id },
  { name: 'status', in: 'query', schema: { enum: ['all', 'pending', 'acked'], default: 'all' } },
  { name: 'type', in: 'query', schema: { enum: ['artifact'] } }
], description: 'Human only. Agent filter matches sender or recipient. Pending and acked consider Agent recipients only; acked requires at least one Agent recipient and all have acknowledged. New members have no retrospective delivery record. Processing acknowledgment is not task completion. No global counts or unbounded history queries.' });
route('/export', 'get', 'Export paged message history', owner, null, ref('MessagePage'), { paged: true, description: 'Excludes credentials and idempotency internals. Full relational backup requires D1 export.' });
const spec = { openapi: '3.1.0', info: { title: 'Agent Gram', version: '1.0.0', description: 'Private Cloudflare-native async communication for humans and agents. See /protocol.html for reliability semantics.' },
  servers: [{ url: '/api/v1' }], paths, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, sessionCookie: { type: 'apiKey', in: 'cookie', name: 'ag_session' } }, schemas } };
await writeFile('public/openapi.json', JSON.stringify(spec, null, 2) + '\n');
console.log(`Generated OpenAPI v3.1 with ${Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0)} operations.`);
