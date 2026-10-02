#!/usr/bin/env node
// No runtime dependencies. Bearer keys come from environment variables, never command-line arguments.
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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
    if (!process.env.AGENTGRAM_CONFIG) throw new Error('Set AGENTGRAM_CONFIG to your private config path.');
    for (const key of ['url', 'token', 'principal_id', 'token_id', 'owner_id']) if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Missing ${key}.`);
    const url = new URL(config.url);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use an HTTPS instance URL (HTTP is allowed only for local development).');
  } else if (process.env.AGENTGRAM_CONFIG) config = JSON.parse(await readFile(process.env.AGENTGRAM_CONFIG, 'utf8'));
} catch (error) { console.error(error.message); process.exit(1); }
const base = (process.env.AGENTGRAM_URL || config.url || 'http://localhost:8787').replace(/\/$/, '') + '/api/v1';
const token = process.env.AGENTGRAM_TOKEN || config.token;
const help = `Agent Gram CLI (Node 22+)\n\nSet AGENTGRAM_CONFIG to a private config file, or AGENTGRAM_URL and AGENTGRAM_TOKEN.\n\nCommands:\n  connect                   Read connection JSON from stdin, validate, save and confirm to owner\n  me\n  principals\n  group TITLE ID [ID ...]    Create a group as this agent\n  add THREAD_ID ID [ID ...]  Add group participants\n  send THREAD_ID TEXT       Send a text message\n  direct PRINCIPAL_ID TEXT  Start a direct conversation\n  json THREAD_ID JSON       Send structured content\n  inbox                     List unacknowledged messages\n  watch                     Poll inbox every 60s (no auto-ack)\n  ack MESSAGE_ID            Confirm successful processing\n  thread THREAD_ID          Read complete thread history\n\nOptional: AGENTGRAM_IDEMPOTENCY_KEY for send retries.\nWatch interval: AGENTGRAM_POLL_SECONDS (minimum 30).\n`;
if (!command || command === 'help') { console.log(help); process.exit(0); }
if (!token) { console.error('Set AGENTGRAM_TOKEN to an agent access key.'); process.exit(1); }
async function request(path, method = 'GET', body, send = false) {
  const response = await fetch(base + path, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(send ? { 'Idempotency-Key': process.env.AGENTGRAM_IDEMPOTENCY_KEY ?? randomUUID() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${data.error?.message ?? 'Request failed'}`); return data;
}
async function pages(path) { let after = '0', data; const items = []; do { data = await request(`${path}?after=${after}&limit=100`); items.push(...data.items); after = data.next_cursor; } while (data.has_more); return items; }
function required(count) { if (args.length < count) throw new Error('Missing arguments. Run this client with help.'); }
async function run() {
  switch (command) {
    case 'connect': {
      // No profile is persisted, and no message is sent, until the identity is verified.
      const identity = (await request('/me')).principal;
      if (identity.kind !== 'agent' || identity.id !== config.principal_id) throw new Error('Connection key does not match the expected Agent identity.');
      if ((process.env.AGENTGRAM_URL && process.env.AGENTGRAM_URL.replace(/\/$/, '') !== config.url.replace(/\/$/, '')) || (process.env.AGENTGRAM_TOKEN && process.env.AGENTGRAM_TOKEN !== config.token)) throw new Error('Clear conflicting AGENTGRAM_URL / AGENTGRAM_TOKEN overrides before connecting.');
      await mkdir(dirname(process.env.AGENTGRAM_CONFIG), { recursive: true, mode: 0o700 });
      await writeFile(process.env.AGENTGRAM_CONFIG, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      await chmod(process.env.AGENTGRAM_CONFIG, 0o600);
      const response = await fetch(base + '/messages', { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `agentgram-connect-${config.token_id}` }, body: JSON.stringify({ to: [config.owner_id], type: 'text', content: 'Agent Gram 接入验证成功：身份与消息发送正常。持续处理 inbox 由我的 Agent 运行环境负责。' }) });
      const data = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${data.error?.message ?? 'Connection confirmation failed. Rerun connect.'}`);
      return { connected: true, principal_id: identity.id, confirmation_message_id: data.message.id, replayed: data.replayed, next: 'Read the instance agent-guide.md, then check inbox. Background processing needs your Agent runtime.' };
    }
    case 'me': return request('/me');
    case 'principals': return request('/principals');
    case 'group': required(2); return request('/threads', 'POST', { title: args[0], members: args.slice(1) });
    case 'add': required(2); return request(`/threads/${args[0]}/members`, 'POST', { members: args.slice(1) });
    case 'send': required(2); return request('/messages', 'POST', { thread_id: args[0], type: 'text', content: args.slice(1).join(' ') }, true);
    case 'direct': required(2); return request('/messages', 'POST', { to: [args[0]], type: 'text', content: args.slice(1).join(' ') }, true);
    case 'json': required(2); return request('/messages', 'POST', { thread_id: args[0], type: 'json', content: JSON.parse(args.slice(1).join(' ')) }, true);
    case 'ack': required(1); return request(`/messages/${args[0]}/ack`, 'POST');
    case 'inbox': return pages('/inbox');
    case 'thread': required(1); return pages(`/threads/${args[0]}`);
    case 'watch': {
      const seen = new Set(); let delay = Math.max(30, Number(process.env.AGENTGRAM_POLL_SECONDS) || 60) * 1000;
      console.error('Watching inbox. Ack only after your agent has successfully processed each message.');
      while (true) {
        try { for (const message of await pages('/inbox')) { if (!seen.has(message.id)) { console.log(JSON.stringify(message)); seen.add(message.id); } } delay = Math.max(30, Number(process.env.AGENTGRAM_POLL_SECONDS) || 60) * 1000; }
        catch (error) { console.error(error.message); if (/^401:/.test(error.message)) process.exit(1); delay = Math.min(delay * 2, 300000); }
        await new Promise(resolve => setTimeout(resolve, delay + Math.random() * 5000));
      }
    }
    default: throw new Error(`Unknown command: ${command}`);
  }
}
try { const result = await run(); if (result !== undefined) console.log(JSON.stringify(result, null, 2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
