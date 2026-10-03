// Explicit live integration test: creates test identities/groups in the configured instance.
// Credentials enter through process environment; raw CLI transcripts stay in memory.
import { readFile, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const base = process.env.AGENTGRAM_URL;
const owner = process.env.AGENTGRAM_OWNER_TOKEN;
if (!base || !owner) throw new Error('Set AGENTGRAM_URL and AGENTGRAM_OWNER_TOKEN in the process environment.');
const claude = process.env.AGENTGRAM_CLAUDE_CLI || 'claude';
const runId = randomUUID();
const report = { runId, checkedAt: new Date().toISOString(), timezone: 'Asia/Shanghai', url: base, checks: [], runtimes: [] };
const credentials = [owner, process.env.GLM_CODING_PLAN_API_KEY].filter(Boolean);
function redact(text) { for (const key of credentials) text = text.replaceAll(key, '[redacted]'); return text; }
async function api(path, method = 'GET', body, key = owner) {
 const r = await fetch(base + '/api/v1' + path, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(path === '/messages' && method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
 const data = await r.json(); if (!r.ok) throw new Error(`API ${path}: ${r.status} ${data.error?.code}`); return data;
}
function runCli(binary, args, prompt, env, cwd) {
 return new Promise((resolveRun, reject) => {
  const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('CLI exceeded four-minute test timeout.')); }, 240000);
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(redact(output).slice(-6000))); else resolveRun(redact(output)); });
  child.stdin.end(prompt);
 });
}
const directory = await mkdtemp(join(tmpdir(), 'agentgram-cli-live-'));
const agents = [];
try {
 await copyFile('scripts/agent.mjs', join(directory, 'agentgram.mjs'));
 for (const name of ['Codex CLI', 'Claude Code']) {
  const result = await api('/agents', 'POST', { name: `${name} · live test`, description: 'Actual local coding-agent runtime integration test; temporary scoped identity.' });
  agents.push({ name, id: result.principal.id, key: result.token.token }); credentials.push(result.token.token);
 }
 report.agentIds = agents.map(a => a.id);
 const thread = (await api('/threads', 'POST', { title: `Codex ↔ Claude Code · ${runId.slice(0, 8)}`, members: agents.map(a => a.id) })).thread;
 report.threadId = thread.id;
 const challenge = (await api('/messages', 'POST', { thread_id: thread.id, type: 'text', content: `Live runtime challenge ${runId}: Codex must read this inbox message and reply CODEX_OK ${runId}; Claude Code must read the actual Codex reply and answer CLAUDE_OK ${runId}. Both must ack only messages they actually processed.` })).message;
 const envFor = agent => {
  const env = { ...process.env, AGENTGRAM_URL: base, AGENTGRAM_TOKEN: agent.key };
  for (const name of ['NODE_USE_ENV_PROXY', 'AGENTGRAM_OWNER_TOKEN', 'AGENTGRAM_CONFIG', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'GLM_CODING_PLAN_API_KEY']) delete env[name];
  return env;
 };
 const instructions = `You are performing an authorized, narrowly scoped Agentgram integration test in a temporary directory. Use only shell commands invoking the provided dependency-free client: node agentgram.mjs me, inbox, send THREAD_ID TEXT, ack MESSAGE_ID. Your private scoped Agent token and URL are already in the environment. Never print or inspect environment credentials, write credentials, change configuration, install packages, or touch other files. Run the actual commands; reporting intended commands is insufficient. This is a mailbox test, not a coding task. `;
 const codexArgs = ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'danger-full-access', '-c', 'approval_policy="never"', '-c', 'shell_environment_policy.inherit="all"', '--json', '-'];
 console.log('Starting actual Codex CLI: read challenge, send reply, acknowledge processing.');
 await runCli('codex', codexArgs, instructions + `Run me and inbox. Locate challenge ${runId}; send to ${thread.id} the exact text CODEX_OK ${runId}; then ack ${challenge.id}. Finish with a brief success/failure report.`, envFor(agents[0]), directory);
 let history = await api('/threads/' + thread.id);
 const codexMessage = history.items.find(m => m.sender_id === agents[0].id && m.content === `CODEX_OK ${runId}`); assert.ok(codexMessage, 'Actual Codex did not send expected message.');
 assert.ok((await api('/messages/' + challenge.id)).receipts.find(r => r.recipient_id === agents[0].id).acked_at);
 report.checks.push('Actual Codex CLI read inbox, replied and acknowledged challenge'); report.runtimes.push({ client: 'Codex CLI', model: 'machine-configured default' });
 console.log('Codex cloud mailbox verified. Starting actual Claude Code CLI.');
 const claudeEnv = envFor(agents[1]);
 if (process.env.GLM_CODING_PLAN_API_KEY) {
  claudeEnv.ANTHROPIC_AUTH_TOKEN = process.env.GLM_CODING_PLAN_API_KEY;
  claudeEnv.ANTHROPIC_BASE_URL = process.env.AGENTGRAM_GLM_BASE_URL || 'https://open.bigmodel.cn/api/anthropic';
  claudeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = process.env.AGENTGRAM_GLM_MODEL || 'glm-5.3-flash';
  claudeEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
 }
 const args = ['-p', '--no-session-persistence', '--permission-mode', 'dontAsk', '--tools', 'Bash', '--allowedTools', 'Bash(node *)', '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--output-format', 'json'];
 await runCli(claude, args, instructions + `Run me and inbox. Locate the actual Codex reply CODEX_OK ${runId}. Send to ${thread.id} the exact text CLAUDE_OK ${runId}; ack ${codexMessage.id} and ${challenge.id}. Finish with a brief success/failure report.`, claudeEnv, directory);
 history = await api('/threads/' + thread.id);
 const claudeMessage = history.items.find(m => m.sender_id === agents[1].id && m.content === `CLAUDE_OK ${runId}`); assert.ok(claudeMessage, 'Actual Claude Code did not send expected message.');
 assert.ok((await api('/messages/' + codexMessage.id)).receipts.find(r => r.recipient_id === agents[1].id).acked_at);
 report.checks.push('Actual Claude Code CLI read Codex reply, responded and acknowledged processing');
 report.runtimes.push({ client: 'Claude Code', provider: process.env.GLM_CODING_PLAN_API_KEY ? 'GLM Coding Plan' : 'existing Claude configuration', model: process.env.GLM_CODING_PLAN_API_KEY ? claudeEnv.ANTHROPIC_DEFAULT_SONNET_MODEL : 'machine-configured default' });
 console.log('Claude Code cloud mailbox verified. Codex will now read the real Claude Code reply.');
 await runCli('codex', codexArgs, instructions + `Run inbox. Locate CLAUDE_OK ${runId}; ack ${claudeMessage.id}. Do not send more messages. Finish with a brief success/failure report.`, envFor(agents[0]), directory);
 assert.ok((await api('/messages/' + claudeMessage.id)).receipts.find(r => r.recipient_id === agents[0].id).acked_at);
 report.checks.push('Actual Codex CLI received and acknowledged Claude Code reply');
 report.success = true;
} catch (error) {
 report.success = false; report.error = redact(error.message); console.log('Live runtime test failed: ' + report.error); process.exitCode = 1;
} finally {
 // Test credentials are disabled after the test; the visible group keeps its audit trail.
 for (const agent of agents) { try { await api('/principals/' + agent.id, 'PATCH', { active: false }); } catch (error) { report.cleanupError = error.message; } }
 if (!report.cleanupError) report.checks.push('Temporary test Agent identities disabled and their keys revoked');
 report.completedAt = new Date().toISOString();
 await rm(directory, { recursive: true, force: true });
 const destination = process.env.AGENTGRAM_LIVE_REPORT || 'docs/live-agents-verification.json';
 await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
 console.log(JSON.stringify(report, null, 2));
}
