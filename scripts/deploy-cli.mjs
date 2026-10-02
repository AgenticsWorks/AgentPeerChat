import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
function wrangler(...args) {
  const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
let config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
let database = config.d1_databases.find(db => db.binding === 'DB');
if (!database) throw new Error('DB binding is missing from wrangler.jsonc.');
console.log('Deploying Agent Gram into the Cloudflare account authenticated by Wrangler.');
if (!database.database_id) {
  wrangler('d1', 'create', database.database_name, '--binding', 'DB', '--update-config');
  config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  database = config.d1_databases.find(db => db.binding === 'DB');
  if (!database?.database_id) throw new Error('D1 was not bound. Set the new database UUID in wrangler.jsonc before retrying.');
}
await mkdir('.wrangler', { recursive: true });
const path = '.wrangler/deployment-secrets.json';
let secrets;
try { secrets = JSON.parse(await readFile(path, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; secrets = { SETUP_SECRET: randomBytes(32).toString('hex') }; }
if (process.env.AGENTGRAM_SETUP_SECRET) secrets.SETUP_SECRET = process.env.AGENTGRAM_SETUP_SECRET;
if (secrets.SETUP_SECRET.length < 24) throw new Error('SETUP_SECRET must contain at least 24 characters.');
await writeFile(path, JSON.stringify(secrets), { mode: 0o600 });
wrangler('d1', 'migrations', 'apply', 'DB', '--remote');
wrangler('deploy', '--secrets-file', path);
console.log('Open the workers.dev URL above. Your setup secret is saved locally in .wrangler/deployment-secrets.json; use it once to create the owner.');
