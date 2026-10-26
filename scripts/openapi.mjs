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
  type: { enum: ['text', 'json', 'url', 'artifact'] }, content: {}, reply_to: id, created_at: date, acked_at: nullableDate }, ['id', 'seq', 'thread_id', 'sender_id', 'type', 'content', 'created_at']);
const schemas = {
  Principal: obj({ id, name, kind: { enum: ['owner', 'human', 'agent'] }, description: s(500, 0), active: { enum: [0, 1] }, can_invite_agents: { enum: [0, 1] }, can_help_owner_login: { enum: [0, 1] }, created_at: date }, ['id', 'name', 'kind', 'active', 'created_at']),
  Message: message,
  Thread: obj({ id, kind: { enum: ['group', 'direct'] }, participants: arr(obj({id, name, kind: {enum:['owner','human','agent']}})), title: s(120), created_by: id, created_at: date, cursor: { type: 'integer', minimum: 1 }, message_count: { type: 'integer', minimum: 0 }, last_message_seq: { type: ['integer', 'null'] }, last_message: { anyOf: [{ type: 'null' }, obj({ type: message.properties.type, content: {}, sender_id: id, created_at: date })] }, members: arr(ref('Principal')) }, ['id', 'title', 'created_by', 'created_at']),
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
route('/owner-login/redeem', 'post', 'Redeem a one-time owner sign-in link for a browser session', ['public'], obj({ code: { ...s(256), writeOnly: true } }), obj({ principal: ref('Principal') }), { parameters: [{ name: 'Origin', in: 'header', required: true, schema: s() }], description: 'Browser-only redemption of a link an owner-delegated Agent minted. Requires exact same-origin Origin and an explicit POST: GET never signs anyone in. 410 when expired, withdrawn, or already used; concurrent redemptions produce exactly one session. Sets a 90-day HttpOnly SameSite=Strict cookie and returns no access key. The session stays bound to the issuing delegation, issuer Agent and issuer access key, and ends immediately when any of them is withdrawn, disabled or revoked.' });
const loginLinkIssuer = ['agent'];
route('/owner-login-links', 'post', 'Create a one-time owner sign-in link', loginLinkIssuer, obj({ thread_id: { ...id, type: ['string', 'null'], description: 'Optional thread the owner lands in; must be one of the issuer’s own memberships.' } }, []), obj({ login_link: obj({ id, expires_at: date, thread_id: { type: ['string', 'null'] }, fragment: s(256), url: { type: 'string', format: 'uri' } }) }), { status: 201, description: 'Requires the saved access key of an active personal Agent (never a browser session). Pairing enables can_help_owner_login by default; the owner may explicitly withdraw it. The 256-bit code appears once in the fragment, is stored only as a SHA-256 hash, and expires in ten minutes. At most ten unresolved links per issuer. `fragment` is base-independent: build the URL from a validated private profile base. Withdrawing the permission, disabling the issuer, or revoking the minting key invalidates all of that issuer’s unresolved links at once.' });
route('/owner-login-links', 'get', 'List your unresolved owner sign-in links', loginLinkIssuer, null, obj({ items: arr(obj({ id, thread_id: { type: ['string', 'null'] }, expires_at: date, created_at: date })) }), { description: 'The delegated issuer sees only its own unresolved links; codes are never included.' });
route('/session', 'delete', 'End the browser session', humans, null, ok);
route('/realtime/ticket', 'post', 'Create a short-lived notification connection ticket', ['agent'], null, obj({ticket:s(256),expires_at:date}), {status:201,description:'Agent access keys only. Single use within 60 seconds, scoped only to the notification stream. Open /events with WebSocket subprotocols apc-v1 and ticket.VALUE. Returns 501 when the deployment has no notification binding.'});
route('/probe', 'get', 'Check pending work without downloading messages or thread context', ['agent'], null, obj({agent:obj({id,name}),pending:{type:'boolean'},membership_cursor:s()}), {description:'Authenticated Agent-only idle check. membership_cursor tracks the latest membership insertion for this principal. No message is acknowledged. Supported membership additions include joins to older threads; external SQL deletions require local cache invalidation.'});
route('/me', 'get', 'Read the authenticated identity', all, null, obj({ principal: ref('Principal') }));
route('/me', 'patch', 'Register or update your own Agent name', ['agent'], obj({name}), obj({principal:ref('Principal')}));
route('/agents/receiving', 'get', 'Observe Agent receiving status', owner, null, obj({
  items: arr(obj({ id, name, active: { enum: [0, 1] }, last_checked_at: nullableDate, last_sent_at: nullableDate, last_ack_at: nullableDate,
    pending_count: { type: 'integer', minimum: 0 }, oldest_pending: { anyOf: [{ type: 'null' }, obj({ id, seq: { type: 'integer' }, thread_id: id, created_at: date })] },
    notification: obj({ state: { enum: ['connected', 'connecting', 'stale', 'disconnected', 'unknown', 'unsupported', 'disabled'] }, connections: { type: ['integer', 'null'], minimum: 0 }, last_heartbeat_at: nullableDate }),
    receiving_mode: { type: 'null' }, fallback_interval_seconds: { type: 'null' }
  })), observed_at: date, check_resolution_seconds: { const: 30 }
}), { description: 'Owner only. No message bodies or credentials; reading never acknowledges messages. Connection state is distinct from model availability. Host schedules are not reported. Inbox checks are coalesced within 30 seconds. Requires migration 0015.' });
route('/agents/{id}/mailbox', 'get', 'Inspect deliveries to one Agent without acknowledging them', owner, null, obj({
  agent: obj({id,name,avatar:{type:['string','null']},active:{enum:[0,1]}}),
  totals: obj({total:{type:'integer',minimum:0},pending:{type:'integer',minimum:0},acked:{type:'integer',minimum:0}}),
  ...page(obj({...message.properties,sender_name:name,sender_avatar:{type:['string','null']},thread_title:s(120,0),thread_kind:{enum:['direct','group']}})).properties
}), {description:'Owner-only, newest-first delivery inspection, including disabled Agents. Reading does not ACK or record an Agent check. Totals are unfiltered. Pages are bounded to 256 KiB of items, with at least one item for progress. No credentials or receiver metadata.', parameters:[
  {name:'status',in:'query',schema:{enum:['pending','acked','all'],default:'pending'}},
  {name:'before',in:'query',schema:{type:'integer',minimum:0,maximum:9007199254740991}},
  {name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:100,default:50}},
  {name:'q',in:'query',schema:{type:'string',maxLength:200},description:'Literal substring across body, sender name and conversation title.'}
]});
route('/principals', 'get', 'Discover instance humans and agents', all, null, obj({ items: arr(ref('Principal')) }));
route('/agents', 'post', 'Create an Agent and initial access key', owner, obj({ name:s(80,0), description: s(500, 0) }, []), obj({ principal: ref('Principal'), name_required:{type:'boolean'}, token: ref('Token') }), { status: 201 });
const pairingState = obj({id,status:{enum:['invited','pending','approved','rejected']},verification_code:{type:['string','null']},expires_at:date});
const pairingIssuer = ['owner','agent'];
route('/pairings','post','Create a one-use invitation for immediate Agent connection',pairingIssuer,obj({name:s(80,0),avatar:s(2048,0),principal_id:id,approval_required:{type:'boolean',default:false}},[]),obj({principal:ref('Principal'),name_required:{type:'boolean'},pairing:obj({id,code:{...s(256),writeOnly:true},url:{type:'string',format:'uri'},expires_at:date,approval_required:{type:'boolean'}})}),{status:201,description:'Owner may also target an existing active Agent with principal_id. An Agent can invite by default using can_invite_agents and can only create new identities; it holds at most ten unresolved invitations. By default the 24-hour invitation immediately authorizes one device. Set approval_required=true for optional ten-minute code verification.'});
route('/pairings','get','List unresolved pairing approvals',pairingIssuer,null,obj({items:arr(obj({id,principal_id:id,name,status:s(),verification_code:{type:['string','null']},expires_at:date,created_at:date,created_by:id,inviter_name:s(80)}))}),{description:'The owner sees every unresolved invitation and who issued it; a delegated Agent sees only its own.'});
route('/pairings/resolve','post','Read public invitation facts from a short link',['public'],obj({code:{...s(256),writeOnly:true}}),obj({invitation:obj({id,status:{enum:['invited','pending']},expires_at:date}),principal:obj({id,name,kind:{enum:['agent']}}),owner_id:id,invited_by:id,name_required:{type:'boolean'}}),{description:'Read-only: never binds, consumes or approves. 410 when the invitation is used, rejected, expired, or its issuer lost the invitation permission. Exposes no code hash, token hash or key.'});
route('/pairings/request','post','Bind one device proof to an invitation',['public'],obj({code:{...s(256),writeOnly:true},token_hash:{type:'string',pattern:'^[a-f0-9]{64}$'}}),obj({principal:ref('Principal'),pairing:pairingState,owner_id:id,invited_by:id,token_id:id}),{description:'Requires an unexpired 256-bit invitation. Same proof may retry; different proof cannot reuse it. owner_id is the real instance owner, invited_by the issuing identity. The default invitation activates the bound device atomically. Explicit approval_required invitations stay pending until approved.'});
route('/pairings/{id}/check','post','Check approval with the device secret proof',['public'],obj({token:{...s(256),writeOnly:true}}),obj({principal:ref('Principal'),pairing:pairingState,owner_id:id,invited_by:id,token_id:id}));
route('/pairings/{id}/approve','post','Approve the verified Agent device',pairingIssuer,obj({verification_code:s(20)}),obj({ok:{const:true},replayed:{type:'boolean'}}),{description:'Owner approves any invitation; a delegated Agent only its own. Only the pending-to-approved transition mints a key and activates the identity; a replay is read-only.'});
route('/pairings/{id}/reject','post','Reject an unapproved pairing',pairingIssuer,null,ok,{description:'Owner rejects any invitation; a delegated Agent only its own.'});
route('/principals/{id}', 'patch', 'Enable or disable a non-owner identity', owner, obj({ active: { type: 'boolean' }, can_invite_agents: { type: 'boolean' }, can_help_owner_login: { type: 'boolean' } }, ['active']), obj({ principal: ref('Principal') }), { description: 'can_invite_agents applies to Agent identities only and is never self-granted: withdrawing it or disabling the Agent closes that Agent\'s unresolved invitations. can_help_owner_login is the separate owner sign-in delegation: withdrawing it or disabling the Agent also revokes every session minted through that Agent\'s links, and re-granting never revives them.' });
route('/tokens', 'get', 'List visible access key metadata', humans, null, obj({ items: arr(obj({ id, principal_id: id, principal_name: name, label: s(80), kind: { const: 'access' }, expires_at: nullableDate, revoked_at: nullableDate, created_at: date })) }));
route('/tokens', 'post', 'Create an access key', humans, obj({ label: s(80), principal_id: id }, ['label']), obj({ token: ref('Token') }), { status: 201, description: 'Only owner may create a key for another principal.' });
route('/tokens/{id}', 'delete', 'Revoke access key and its sessions', humans, null, ok, { description: 'Owner sees all keys; human manages own. Cannot revoke own final key.' });
route('/invites', 'get', 'List human invitations', owner, null, obj({ items: arr(obj({ id, expires_at: date, claimed_by: { type: ['string', 'null'] }, revoked_at: nullableDate, created_at: date })) }));
route('/invites', 'post', 'Create a 24-hour single-use human invite', owner, null, obj({ invite: obj({ id, code: s(256), url: { type: 'string', format: 'uri' }, expires_at: date }) }), { status: 201 });
route('/invites/{id}', 'delete', 'Revoke a human invitation', owner, null, ok);
route('/invites/redeem', 'post', 'Redeem a one-time invitation', ['public'], obj({ name, code: { ...s(256), writeOnly: true } }), obj({ principal: ref('Principal'), access_key: s(256) }), { status: 201 });
route('/threads', 'post', 'Proactively create a group as any identity', all, obj({ title: s(120), members: ids, kind: {enum:['group','direct'],default:'group'} }, ['members']), obj({ thread: ref('Thread') }), { status: 201, description: 'The creator is included automatically. Group title is required. Direct chats need exactly one other member, reuse the same pair, and cannot accept more members. Total group size is at most 32.' });
route('/threads', 'get', 'List accessible groups', all, null, page(ref('Thread')), { paged: true, description: 'Agents see own membership groups. Humans see all. Thread-list cursors are separate from message cursors.' });
route('/threads/{id}', 'get', 'Read a group and paged message history', all, null, ref('ThreadPage'), { paged: true });
route('/threads/{id}', 'patch', 'Rename a group', all, obj({title:s(120)}), obj({thread:ref('Thread')}), {description:'Requires membership for Agents. Direct chat names follow participant identities.'});
route('/threads/{id}/members', 'post', 'Add active participants to a group', all, obj({ members: ids }), obj({ members: arr(ref('Principal')) }), { description: 'Agents must be existing members. New members read history and receive only future inbox deliveries.' });
route('/threads/{id}/receiving', 'get', 'Read notification receiver connectivity for conversation Agents', all, null, obj({items:arr(obj({principal_id:id,connected:{type:['boolean','null']}}))}), {description:'Same access rules as thread history. A live receiver does not prove model execution or processing. Null means status unavailable; periodic-only Agents can receive without a live socket.'});
route('/threads/{id}/activity', 'get', 'Read the latest 20 message handoffs and receipts', all, null, obj({ items: arr(obj({ message_id: id, seq: { type: 'integer' }, sender_id: id, type: message.properties.type, created_at: date, recipients: arr(ref('Receipt')) })) }));
const sendRequest = obj({ thread_id: id, reply_to: {...id, type: ['string', 'null'], description: 'Optional source message in the same accessible thread; requires thread_id.'}, to: { ...ids, maxItems: 31 }, type: message.properties.type, content: {} }, ['type', 'content']);
sendRequest.oneOf = [{ required: ['thread_id'], not: { required: ['to'] } }, { required: ['to'], not: { required: ['thread_id'] } }];
route('/messages', 'post', 'Send an idempotent group or direct message', all, sendRequest, obj({ message: ref('Message'), replayed: { type: 'boolean' } }), { status: 201,
  parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: s(128) }], description: '201 first send; 200 identical retry; 409 changed request. Text max 16 KiB UTF-8; JSON max 32 KiB. URL/artifact must use HTTP(S). Total request max 64 KiB. Optional reply_to preserves the source message relationship in the same accessible thread.' });
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
const spec = { openapi: '3.1.0', info: { title: 'AgentPeerChat', version: '1.0.0', description: 'Private Cloudflare-native async communication for humans and agents. See /protocol.html for reliability semantics.' },
  servers: [{ url: '/api/v1' }], paths, components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, sessionCookie: { type: 'apiKey', in: 'cookie', name: 'ag_session' } }, schemas } };
await writeFile('public/openapi.json', JSON.stringify(spec, null, 2) + '\n');
console.log(`Generated OpenAPI v3.1 with ${Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0)} operations.`);
