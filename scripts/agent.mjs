#!/usr/bin/env node
// No runtime dependencies. Bearer keys come from environment variables, never command-line arguments.
import { randomUUID } from 'node:crypto';
const base = (process.env.AGENTGRAM_URL ?? 'http://localhost:8787').replace(/\/$/, '') + '/api/v1';
const token = process.env.AGENTGRAM_TOKEN;
const [command, ...args] = process.argv.slice(2);
const help = `Agent Gram CLI (Node 22+)\n\nSet AGENTGRAM_URL and AGENTGRAM_TOKEN.\n\nCommands:\n  me\n  principals\n  group TITLE ID [ID ...]    Create a group as this agent\n  add THREAD_ID ID [ID ...]  Add group participants\n  send THREAD_ID TEXT       Send a text message\n  direct PRINCIPAL_ID TEXT  Start a direct conversation\n  json THREAD_ID JSON       Send structured content\n  inbox                     List unacknowledged messages\n  watch                     Poll inbox every 60s (no auto-ack)\n  ack MESSAGE_ID            Confirm successful processing\n  thread THREAD_ID          Read complete thread history\n\nOptional: AGENTGRAM_IDEMPOTENCY_KEY for send retries.\nWatch interval: AGENTGRAM_POLL_SECONDS (minimum 30).\n`;
if (!command || command === 'help') { console.log(help); process.exit(0); }
if (!token) { console.error('Set AGENTGRAM_TOKEN to an agent access key.'); process.exit(1); }
async function request(path, method = 'GET', body, send = false) {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`,
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(send ? { 'Idempotency-Key': process.env.AGENTGRAM_IDEMPOTENCY_KEY ?? randomUUID() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${data.error?.message ?? 'Request failed'}`); return data;
}
async function pages(path) { let after = '0', data; const items = []; do { data = await request(`${path}?after=${after}&limit=100`); items.push(...data.items); after = data.next_cursor; } while (data.has_more); return items; }
function required(count) { if (args.length < count) throw new Error('Missing arguments. Run: npm run client -- help'); }
async function run() {
  switch (command) {
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
