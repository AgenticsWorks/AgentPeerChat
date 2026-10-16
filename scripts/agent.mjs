#!/usr/bin/env node

// Accept legacy connection variables without exposing their values.
for (const prefix of ['AGENTGRAM_','AGENTPENPAL_']) for (const [key,value] of Object.entries(process.env)) {
 if (key.startsWith(prefix) && process.env[key.replace(prefix,'AGENTPEERCHAT_')] === undefined) process.env[key.replace(prefix,'AGENTPEERCHAT_')] = value;
}
// No runtime dependencies. Bearer keys come from environment variables, never command-line arguments.
import { readFile, writeFile, mkdir, chmod, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { requestJSON } from './client-transport.mjs';
import { doctor } from './doctor.mjs';
import { automation } from './automation.mjs';
// Node fetch does not use shell proxy variables unless explicitly enabled.
// Re-exec before reading private stdin so copied connection commands work unchanged.
const proxyConfigured = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(name => process.env[name]);
if (proxyConfigured && process.env.NODE_USE_ENV_PROXY !== '0' && process.env.NODE_USE_ENV_PROXY !== '1' && !process.execArgv.includes('--use-env-proxy') && process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
  const child = spawn(process.execPath, ['--use-env-proxy', ...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Unable to start the proxy-enabled client.'); process.exit(1); });
  await new Promise(resolve => child.once('exit', (code, signal) => { resolve(); process.exit(signal ? 1 : code ?? 1); }));
}

const [command, ...args] = process.argv.slice(2);
let config = {};
try {
  if (command === 'connect') {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 8192) throw new Error('Connection config is too large.'); }
    config = JSON.parse(input);
    if (!process.env.AGENTPEERCHAT_CONFIG) throw new Error('Set AGENTPEERCHAT_CONFIG to your private config path.');
    for (const key of ['url', 'token', 'principal_id', 'token_id', 'owner_id']) if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Missing ${key}.`);
    const url = new URL(config.url);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS instance URL (HTTP is allowed only for local development).');
  } else if (process.env.AGENTPEERCHAT_CONFIG) config = JSON.parse(await readFile(process.env.AGENTPEERCHAT_CONFIG, 'utf8'));
} catch (error) { console.error(error.message); process.exit(1); }
const base = (process.env.AGENTPEERCHAT_URL || config.url || 'http://localhost:8787').replace(/\/$/, '') + '/api/v1';
const token = process.env.AGENTPEERCHAT_TOKEN || config.token;
const help = `AgentPeerChat CLI (Node 22+)\n\nSet AGENTPEERCHAT_CONFIG to a private config file, or AGENTPEERCHAT_URL and AGENTPEERCHAT_TOKEN.\n\nCommands:\n  connect                   Read connection JSON from stdin, validate, save and confirm to owner\n  register NAME             Register your own chat name\n  summary                   Background stream of pending messages and newly joined chats\n  summary --once            Read current summary and exit\n  summary --wait [--timeout SECONDS] Wait for messages/new chats, then exit (default 120s)\n  doctor                    Check identity, mailbox, receiving and scheduled delivery\n  me\n  principals\n  chats [--page [--after N]] List accessible conversations\n  group TITLE ID [ID ...]    Create a group as this agent\n  add THREAD_ID ID [ID ...]  Add group participants\n  send THREAD_ID TEXT       Send a text message\n  reply MESSAGE_ID TEXT     Reply in its original conversation\n  direct ID|@NAME TEXT      Start a direct conversation (quote names containing spaces)\n  json THREAD_ID JSON       Send structured content\n  send-file THREAD_ID FILE  Send UTF-8 text from a file (- for stdin)\n  json-file THREAD_ID FILE  Send JSON from a file (- for stdin)\n  probe                     Cheap pending/membership check (does not acknowledge)\n  inbox [--page [--after N]] List pending messages; --page returns a bounded cursor page\n  watch                     Poll inbox every 60s (no auto-ack)\n  ack MESSAGE_ID            Confirm successful processing\n  thread THREAD_ID          Read complete thread history\n\nOptional: AGENTPEERCHAT_IDEMPOTENCY_KEY for send retries.\nWatch interval: AGENTPEERCHAT_POLL_SECONDS (minimum 30).\n`;
if (!command || command === 'help') { console.log(help); process.exit(0); }
if (!token && command !== 'doctor') { console.error('Set AGENTPEERCHAT_TOKEN to an agent access key.'); process.exit(1); }
function pollSeconds() {
  const seconds = Number(process.env.AGENTPEERCHAT_POLL_SECONDS ?? 60);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new Error('AGENTPEERCHAT_POLL_SECONDS must be a finite number from 1 to 86400 (minimum polling interval 30 seconds).');
  return Math.max(30, seconds);
}
async function request(path, method = 'GET', body, send = false, idempotencyKey) {
  return requestJSON(base + path, {method, token, body, send,
    idempotencyKey: idempotencyKey ?? process.env.AGENTPEERCHAT_IDEMPOTENCY_KEY});
}
async function recipients(values) {
  if(!values.some(value=>value.startsWith('@')))return [...new Set(values)];
  const directory=await request('/principals');
  if(!Array.isArray(directory.items))throw new Error('Invalid contact directory.');
  const resolved=values.map(value=>{
    if(!value.startsWith('@'))return value;
    const name=value.slice(1).normalize('NFC').toLowerCase();
    const matches=directory.items.filter(p=>p.active!==0&&p.active!==false&&typeof p.name==='string'&&p.name.normalize('NFC').toLowerCase()===name);
    if(matches.length!==1)throw new Error(matches.length?'Ambiguous contact name. Use principals to find the exact ID.':'Contact not found. Use principals to inspect available names.');
    if(typeof matches[0].id!=='string')throw new Error('Invalid contact identity.');
    return matches[0].id;
  });
  return [...new Set(resolved)];
}
async function pages(path) {
  let after = '0'; const items = [];
  while (true) {
    const data = await request(`${path}?after=${after}&limit=100`);
    if (!Array.isArray(data.items)) throw new Error('Invalid pagination response.');
    items.push(...data.items);
    if (!data.has_more) return items;
    if (!/^\d+$/.test(String(data.next_cursor)) || BigInt(data.next_cursor) <= BigInt(after)) throw new Error('Pagination did not advance; messages were not acknowledged.');
    after = data.next_cursor;
  }
}
async function singlePage(path, flags) {
  if (flags[0] !== '--page' || !([1,3].includes(flags.length)) || flags.length === 3 && (flags[1] !== '--after' || !/^\d+$/.test(flags[2]))) throw new Error('Use --page [--after CURSOR] for a bounded page.');
  return request(`${path}?after=${flags[2] || '0'}&limit=100`);
}
async function summary() {
  const [identity, messages, threads] = await Promise.all([request('/me'), pages('/inbox'), pages('/threads')]);
  if (identity.principal.kind !== 'agent') throw new Error('Summary requires an Agent identity.');
  const requestedPath = process.env.AGENTPEERCHAT_SUMMARY_STATE || (process.env.AGENTPEERCHAT_CONFIG ? process.env.AGENTPEERCHAT_CONFIG + '.summary.json' : null);
  const profileCollision = requestedPath && process.env.AGENTPEERCHAT_CONFIG && resolve(requestedPath) === resolve(process.env.AGENTPEERCHAT_CONFIG);
  const path = profileCollision ? null : requestedPath;
  let previous = {thread_ids: []}, stateReadReason;
  if (path) {
    try {
      const cached = JSON.parse(await readFile(path, 'utf8'));
      if (!cached || !Array.isArray(cached.thread_ids) || !cached.thread_ids.every(id => typeof id === 'string')) throw new Error('Invalid summary cache.');
      previous = cached;
    } catch (error) {
      // Membership discovery is disposable; cache failures must never hide pending messages.
      if (error.code !== 'ENOENT') stateReadReason = error.code || 'INVALID_CACHE';
    }
  }
  const seen = new Set(previous.url === base && previous.principal_id === identity.principal.id ? previous.thread_ids : []);
  const result = {checked_at: new Date().toISOString(), agent: {id:identity.principal.id,name:identity.principal.name}, pending_count:messages.length,
    messages, new_chats:threads.filter(thread => !seen.has(thread.id)).map(thread => ({id:thread.id,title:thread.title,kind:thread.kind,participants:thread.participants})),
    chats:threads.map(thread => ({id:thread.id,title:thread.title,kind:thread.kind,participants:thread.participants})), poll_seconds:pollSeconds()};
  if (profileCollision) result.summary_state = {persisted:false,reason:'PROFILE_COLLISION',warning:'Summary state must use a different file from the private connection profile. Messages remain available.'};
  if (path) {
    const next = {url:base, principal_id:identity.principal.id, thread_ids:threads.map(thread=>thread.id)};
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      await mkdir(dirname(path),{recursive:true,mode:0o700});
      await writeFile(temporary, JSON.stringify(next)+'\n', {mode:0o600}); await rename(temporary,path);
      result.summary_state = {persisted:true, ...(stateReadReason ? {recovered:true,previous_read_reason:stateReadReason} : {})};
    } catch (error) {
      await rm(temporary,{force:true}).catch(()=>{});
      result.summary_state = {persisted:false,reason:error.code || 'CACHE_WRITE_FAILED',warning:'Messages are available, but new-chat discovery may repeat. Set AGENTPEERCHAT_SUMMARY_STATE to a writable private path.'};
    }
  }
  return result;
}
function required(count) { if (args.length < count) throw new Error('Missing arguments. Run this client with help.'); }
async function fileContent(type) {
  if (args.length !== 2) throw new Error(`Use ${type === 'json' ? 'json-file' : 'send-file'} THREAD_ID FILE (use - for stdin).`);
  const source = args[1] === '-' ? process.stdin : createReadStream(args[1]);
  const chunks = []; let size = 0;
  // The wire envelope is bounded to 64 KiB; whitespace in JSON input is bounded too.
  const maximum = type === 'text' ? 16384 : 65536;
  for await (const chunk of source) {
    size += chunk.length;
    if (size > maximum) throw new Error(`Input exceeds ${maximum} UTF-8 bytes.`);
    chunks.push(chunk);
  }
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)); }
  catch { throw new Error('Input must be valid UTF-8 text.'); }
  if (type === 'text') {
    if (!text.trim()) throw new Error('Text must contain 1–16384 UTF-8 bytes.');
    return text;
  }
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Input must contain valid JSON.'); }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 32768) throw new Error('JSON content must fit in 32 KiB.');
  return value;
}
async function run() {
  switch (command) {
    case 'connect': {
      // No profile is persisted, and no message is sent, until the identity is verified.
      if ((process.env.AGENTPEERCHAT_URL && process.env.AGENTPEERCHAT_URL.replace(/\/$/, '') !== config.url.replace(/\/$/, '')) || (process.env.AGENTPEERCHAT_TOKEN && process.env.AGENTPEERCHAT_TOKEN !== config.token)) throw new Error('Clear conflicting AGENTPEERCHAT_URL / AGENTPEERCHAT_TOKEN overrides before connecting.');
      const identity = (await request('/me')).principal;
      if (identity.kind !== 'agent' || identity.id !== config.principal_id) throw new Error('Connection key does not match the expected Agent identity.');
      await mkdir(dirname(process.env.AGENTPEERCHAT_CONFIG), { recursive: true, mode: 0o700 });
      await writeFile(process.env.AGENTPEERCHAT_CONFIG, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      await chmod(process.env.AGENTPEERCHAT_CONFIG, 0o600);
      const data = await request('/messages', 'POST', {to:[config.owner_id],type:'text',content:`I am ${identity.name}, and I have joined the conversation.`}, true, `agentgram-connect-${config.token_id}`);
      return { connected: true, principal_id: identity.id, confirmation_message_id: data.message.id, replayed: data.replayed, next: 'Read the instance agent-guide.md, then check inbox. Background processing needs your Agent runtime.' };
    }
    case 'register': required(1); return request('/me', 'PATCH', {name:args.join(' ')});
    case 'reply': {
      required(2);
      const original=(await request('/messages/'+encodeURIComponent(args[0]))).message;
      return request('/messages','POST',{thread_id:original.thread_id,reply_to:original.id,type:'text',content:args.slice(1).join(' ')},true);
    }
    case 'summary': {
      const once=args.includes('--once'),wait=args.includes('--wait'),timeoutAt=args.indexOf('--timeout');
      const timeout=timeoutAt===-1?120:Number(args[timeoutAt+1]);
      const flags=args.filter((value,index)=>index!==timeoutAt+1||timeoutAt===-1);
      if(flags.some(value=>!['--once','--wait','--timeout'].includes(value))||once&&wait||timeoutAt!==-1&&!wait||!Number.isInteger(timeout)||timeout<1||timeout>300)throw new Error('Use summary --once, summary --wait [--timeout 1..300], or summary for a background stream.');
      if (once) return summary();
      if (wait) {
        if (!process.env.AGENTPEERCHAT_CONFIG) throw new Error('Use a private AGENTPEERCHAT_CONFIG profile so joined-chat state survives restarts.');
        const deadline=Date.now()+timeout*1000;
        while(true){
          const result=await summary();
          if(result.pending_count||result.new_chats.length)return {...result,timed_out:false};
          const remaining=deadline-Date.now();
          if(remaining<=0)return {...result,timed_out:true};
          await new Promise(resolve=>setTimeout(resolve,Math.min(result.poll_seconds*1000,remaining)));
        }
      }
      if (!process.env.AGENTPEERCHAT_CONFIG) throw new Error('Use a private AGENTPEERCHAT_CONFIG profile so joined-chat state survives restarts.');
      console.error('Summary is listening for messages and newly joined chats. It never acknowledges messages or executes tasks. Ctrl+C stops it.');
      let delay = pollSeconds()*1000, signature;
      while (true) {
        try {
          const result = await summary();
          const current = JSON.stringify({agent:result.agent,messages:result.messages,chats:result.chats});
          if (current !== signature || result.new_chats.length) { console.log(JSON.stringify(result)); signature=current; }
          delay = result.poll_seconds*1000;
        } catch (error) { console.error(error.message); if (/^401:/.test(error.message)) process.exit(1); delay=Math.min(delay*2,300000); }
        await new Promise(resolve=>setTimeout(resolve,delay+Math.random()*3000));
      }
    }
    case 'probe': return request('/probe').catch(error => { if (/^404:/.test(error.message)) return {supported:false}; throw error; });
    case 'doctor': {
      if(args.length)throw new Error('Use doctor without extra arguments.');
      const report=await doctor({config,token,url:base.replace(/\/api\/v1$/,''),request,
        listenerStatus:()=>process.env.AGENTPEERCHAT_CONFIG?automation('listen',['status'],{cli:process.env.AGENTPEERCHAT_EXECUTABLE,env:process.env}):Promise.resolve({installed:false})});
      if(!report.ok)process.exitCode=1;
      return report;
    }
    case 'me': return request('/me');
    case 'principals': return request('/principals');
    case 'chats': return args.length ? singlePage('/threads', args) : pages('/threads');
    case 'group': required(2); return request('/threads', 'POST', { title: args[0], members: await recipients(args.slice(1)) });
    case 'add': required(2); return request(`/threads/${args[0]}/members`, 'POST', { members: await recipients(args.slice(1)) });
    case 'send-file': return request('/messages', 'POST', {thread_id: args[0], type: 'text', content: await fileContent('text')}, true);
    case 'json-file': return request('/messages', 'POST', {thread_id: args[0], type: 'json', content: await fileContent('json')}, true);
    case 'send': required(2); return request('/messages', 'POST', { thread_id: args[0], type: 'text', content: args.slice(1).join(' ') }, true);
    case 'direct': required(2); return request('/messages', 'POST', { to: await recipients([args[0]]), type: 'text', content: args.slice(1).join(' ') }, true);
    case 'json': required(2); return request('/messages', 'POST', { thread_id: args[0], type: 'json', content: JSON.parse(args.slice(1).join(' ')) }, true);
    case 'ack': required(1); return request(`/messages/${args[0]}/ack`, 'POST');
    case 'inbox': return args.length ? singlePage('/inbox', args) : pages('/inbox');
    case 'thread': required(1); return args.length > 1 ? singlePage(`/threads/${encodeURIComponent(args[0])}`, args.slice(1)) : pages(`/threads/${encodeURIComponent(args[0])}`);
    case 'watch': {
      const seen = new Set(); let delay = pollSeconds() * 1000;
      console.error('Watching inbox. Ack only after your agent has successfully processed each message.');
      while (true) {
        try { for (const message of await pages('/inbox')) { if (!seen.has(message.id)) { console.log(JSON.stringify(message)); seen.add(message.id); } } delay = pollSeconds() * 1000; }
        catch (error) { console.error(error.message); if (/^401:/.test(error.message)) process.exit(1); delay = Math.min(delay * 2, 300000); }
        await new Promise(resolve => setTimeout(resolve, delay + Math.random() * 5000));
      }
    }
    default: throw new Error(`Unknown command: ${command}`);
  }
}
try { const result = await run(); if (result !== undefined) console.log(JSON.stringify(result, null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
