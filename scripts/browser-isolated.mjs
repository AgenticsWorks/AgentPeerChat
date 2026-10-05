// Run the full first-install flow without touching the user's running D1 or credentials.
import { cp, mkdtemp, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
const root = process.cwd();
const backend = process.argv[2] === 'sqlite' ? 'sqlite' : 'd1';
const directory = await mkdtemp(join(tmpdir(), 'agentpeerchat-browser-'));
const env = { ...process.env, AGENTPEERCHAT_BROWSER_BACKEND: backend, WRANGLER_SEND_METRICS: 'false', AGENTPEERCHAT_BROWSER_SESSION: `isolated-${basename(directory)}` };
let worker;
function command(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: directory, env, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${basename(script)} exited ${code}`)));
  });
}
try {
  await cp(root, directory, { recursive: true, filter: path => !['node_modules', '.wrangler', '.git', '.env', '.dev.vars', 'dist', 'test-results', 'data', '.server.env'].includes(basename(path)) });
  await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const setupSecret = randomBytes(32).toString('hex');
  await writeFile(join(directory, '.dev.vars'), `SETUP_SECRET=${setupSecret}\n`, { mode: 0o600 });
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  env.AGENTPEERCHAT_TEST_URL = `http://127.0.0.1:${port}`;
  await command('scripts/build-docs.mjs');
  if (backend === 'sqlite') {
    await command('scripts/build-server.mjs');
    env.SETUP_SECRET = setupSecret; env.PORT = String(port); env.AGENTPEERCHAT_PUBLIC_URL = env.AGENTPEERCHAT_TEST_URL;
    worker = spawn(process.execPath, ['server/start.mjs'], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    await command('node_modules/wrangler/bin/wrangler.js', ['d1', 'migrations', 'apply', 'DB', '--local']);
    worker = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--ip', '127.0.0.1', '--port', String(port)], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  let failure; worker.on('error', error => { failure = error; });
  worker.stdout.on('data', () => {}); worker.stderr.on('data', () => {});
  const deadline = Date.now() + 45000;
  let ready = false;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    if (worker.exitCode !== null) throw new Error('Isolated Worker exited before readiness.');
    try { const response = await fetch(env.AGENTPEERCHAT_TEST_URL + '/api/v1/status'); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Isolated Worker did not become ready within 45 seconds.');
  console.log('Running first-owner setup and browser/API/storage flows in an isolated database.');
  await command('scripts/browser-check.mjs');
  await mkdir(join(root, 'docs/screenshots'), { recursive: true });
  await cp(join(directory, 'docs/screenshots'), join(root, 'docs/screenshots'), { recursive: true });
  await cp(join(directory, 'docs/browser-verification.json'), join(root, backend === 'sqlite' ? 'docs/browser-verification-server.json' : 'docs/browser-verification.json'));
  console.log('Verification artifacts saved. The running user instance was not modified.');
} finally {
  if (worker && worker.exitCode === null) {
    await new Promise(resolve => {
      worker.once('exit', resolve); worker.kill('SIGTERM');
      const timer = setTimeout(() => { worker.kill('SIGKILL'); resolve(); }, 5000); timer.unref();
    });
  }
  await rm(directory, { recursive: true, force: true });
}
