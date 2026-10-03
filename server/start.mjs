import worker from '../dist/server/worker.mjs';
import { fileURLToPath } from 'node:url';
import { createApplication } from './app.mjs';
const port = Number(process.env.PORT ?? 3000), host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
const application = await createApplication({ worker, databasePath: process.env.AGENTGRAM_DATABASE ?? 'data/agentgram.sqlite',
  setupSecret: process.env.SETUP_SECRET, publicUrl: process.env.AGENTGRAM_PUBLIC_URL ?? `http://127.0.0.1:${port}`,
  assetsDirectory: fileURLToPath(new URL('../public/', import.meta.url)), migrationsDirectory: fileURLToPath(new URL('../migrations/', import.meta.url)) });
application.server.listen(port, host, () => console.log(`Agentgram server ready at ${process.env.AGENTGRAM_PUBLIC_URL ?? `http://127.0.0.1:${port}`} (persistent SQLite).`));
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; const timer = setTimeout(() => process.exit(1), 10000); timer.unref(); await application.close(); clearTimeout(timer); process.exit(0); });
